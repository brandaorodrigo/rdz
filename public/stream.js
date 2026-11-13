const state = {
    channel: null,
    connected: false,
    loopback: null,
    picking: false,
    recorder: null,
    stopping: false,
    stream: null,
    ws: null,
};

let waiter = null;
const toast = document.getElementById('toast');

function showToast(message) {
    toast.textContent = message || '';
}

function send(payload) {
    state.ws.send(JSON.stringify(payload));
}

function releaseDesktopAudio() {
    const graph = state.loopback;
    state.loopback = null;
    if (graph) {
        graph.unsubscribe();
        graph.ctx.close().catch(() => {});
    }
    if (window.rdzDesktop) {
        window.rdzDesktop.stopAudio();
    }
}

function dropCapture() {
    releaseDesktopAudio();
    if (state.recorder && state.recorder.state !== 'inactive') {
        state.recorder.ondataavailable = null;
        try {
            state.recorder.stop();
        } catch {
            /* already stopped */
        }
    }
    if (state.stream) {
        for (const track of state.stream.getTracks()) {
            track.stop();
        }
    }
    state.recorder = null;
    state.stream = null;
    for (const video of document.querySelectorAll('[data-preview]')) {
        video.srcObject = null;
        video.hidden = true;
    }
}

function finishStop() {
    dropCapture();
    state.channel = null;
    state.stopping = false;
    render();
}

function waitFor(match, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            waiter = null;
            reject(new Error('O servidor não respondeu.'));
        }, timeoutMs);
        waiter = {
            match,
            resolve: (msg) => {
                clearTimeout(timer);
                waiter = null;
                resolve(msg);
            },
        };
    });
}

function handle(msg) {
    if (msg.type === 'stopped') {
        if (!msg.channel || msg.channel === state.channel) {
            finishStop();
        }
        return;
    }
    if (msg.type === 'error' && !waiter?.match(msg)) {
        showToast(msg.message);
        finishStop();
    }
}

function connect() {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${location.host}/ws`);
    state.ws = ws;

    ws.addEventListener('open', () => {
        state.connected = true;
        showToast('');
        render();
    });

    ws.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') {
            return;
        }
        let msg;
        try {
            msg = JSON.parse(event.data);
        } catch {
            return;
        }
        handle(msg);
        if (waiter?.match(msg)) {
            waiter.resolve(msg);
        }
    });

    ws.addEventListener('close', () => {
        state.connected = false;
        if (state.channel) {
            dropCapture();
            state.channel = null;
            state.stopping = false;
            showToast('Conexão com o servidor perdida.');
        }
        render();
        setTimeout(connect, 1000);
    });
}

function settings(channel) {
    const card = document.querySelector(`[data-channel="${channel}"]`);
    const fps = Number(card.querySelector('[data-fps]').value);
    return { fps, height: 1080, width: 1920 };
}

let pickerResolver = null;

function closePicker(result) {
    const picker = document.getElementById('picker');
    const list = document.getElementById('picker-list');
    picker.hidden = true;
    list.replaceChildren();
    const resolve = pickerResolver;
    pickerResolver = null;
    if (resolve) {
        resolve(result);
    }
}

function chooseWindow(api) {
    const picker = document.getElementById('picker');
    const list = document.getElementById('picker-list');
    return api.listWindows().then((windows) => {
        if (!windows.length) {
            const error = new Error('Nenhuma janela disponível.');
            error.name = 'RdzError';
            throw error;
        }
        list.replaceChildren();
        return new Promise((resolve) => {
            pickerResolver = resolve;
            for (const item of windows) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'window-choice';
                if (item.thumbnail) {
                    const thumb = document.createElement('img');
                    thumb.alt = '';
                    thumb.src = item.thumbnail;
                    button.append(thumb);
                }
                const label = document.createElement('span');
                label.textContent = item.name;
                button.append(label);
                button.addEventListener('click', () => closePicker(item));
                list.append(button);
            }
            picker.hidden = false;
        });
    });
}

function floatsFromBytes(bytes) {
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    return new Float32Array(copy);
}

function closeLoopbackGraph() {
    const graph = state.loopback;
    state.loopback = null;
    if (!graph) {
        return;
    }
    graph.unsubscribe();
    graph.ctx.close().catch(() => {});
}

async function connectLoopback(stream) {
    closeLoopbackGraph();
    const ctx = new AudioContext({ sampleRate: 48000 });
    try {
        await ctx.resume();
        await ctx.audioWorklet.addModule('/loopback-worklet.js');
        const node = new AudioWorkletNode(ctx, 'rdz-loopback', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
        const dest = ctx.createMediaStreamDestination();
        dest.channelCount = 2;
        dest.channelCountMode = 'explicit';
        node.connect(dest);
        const unsubscribe = window.rdzDesktop.onPcm((bytes) => {
            if (!bytes?.byteLength) {
                return;
            }
            node.port.postMessage(floatsFromBytes(bytes));
        });
        stream.addTrack(dest.stream.getAudioTracks()[0]);
        state.loopback = { ctx, unsubscribe };
    } catch (err) {
        ctx.close().catch(() => {});
        throw err;
    }
}

async function captureDesktop(width, height, fps) {
    const api = window.rdzDesktop;
    state.picking = true;
    render();
    let picked;
    try {
        picked = await chooseWindow(api);
    } finally {
        state.picking = false;
        render();
    }
    if (!picked) {
        const error = new Error('cancelado');
        error.name = 'AbortError';
        throw error;
    }
    if (!api.arm(picked.id)) {
        const error = new Error('Essa janela não está mais disponível.');
        error.name = 'RdzError';
        throw error;
    }
    const stream = await navigator.mediaDevices.getDisplayMedia({
        audio: false,
        video: { frameRate: { ideal: fps, max: fps }, height: { ideal: height }, width: { ideal: width } },
    });
    try {
        const started = await api.beginAudio(picked.id);
        if (!started) {
            const error = new Error('Não foi possível capturar o áudio dessa janela.');
            error.name = 'RdzError';
            throw error;
        }
        await connectLoopback(stream);
    } catch (err) {
        releaseDesktopAudio();
        for (const track of stream.getTracks()) {
            track.stop();
        }
        throw err;
    }
    return stream;
}

async function captureWindow(width, height, fps) {
    if (window.rdzDesktop) {
        return captureDesktop(width, height, fps);
    }
    const video = { displaySurface: 'window', frameRate: { ideal: fps, max: fps }, height: { ideal: height }, width: { ideal: width } };
    const advanced = {
        audio: { autoGainControl: false, echoCancellation: false, noiseSuppression: false },
        monitorTypeSurfaces: 'exclude',
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'exclude',
        systemAudio: 'include',
        video,
    };
    try {
        return await navigator.mediaDevices.getDisplayMedia(advanced);
    } catch (err) {
        if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
            throw err;
        }
        return navigator.mediaDevices.getDisplayMedia({ audio: true, systemAudio: 'include', video });
    }
}

function startRecorder(stream) {
    const mime = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm'].find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 128_000, videoBitsPerSecond: 16_000_000 });
    recorder.addEventListener('dataavailable', async (event) => {
        if (!event.data.size || state.stopping || !state.ws || state.ws.readyState !== WebSocket.OPEN) {
            return;
        }
        const buffer = await event.data.arrayBuffer();
        if (!state.stopping && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(buffer);
        }
    });
    recorder.addEventListener('error', () => {
        showToast('Falha ao gravar a janela.');
        stop();
    });
    recorder.start(250);
    state.recorder = recorder;
}

async function transmit(channel) {
    if (!window.isSecureContext) {
        showToast('A captura de janela só funciona em localhost ou HTTPS.');
        return;
    }
    if (!state.connected || state.picking || (state.channel === channel && !state.stopping)) {
        return;
    }

    const { width, height, fps } = settings(channel);
    let stream;
    try {
        stream = await captureWindow(width, height, fps);
    } catch (err) {
        const cancelled = err && (err.name === 'NotAllowedError' || err.name === 'AbortError');
        showToast(cancelled ? 'Seleção de janela cancelada.' : (err && err.name === 'RdzError' && err.message) || 'Não foi possível capturar a janela.');
        return;
    }
    const audioBefore = state.loopback;
    if (stream.getAudioTracks().length === 0) {
        for (const track of stream.getTracks()) {
            track.stop();
        }
        if (state.loopback !== audioBefore) {
            releaseDesktopAudio();
        }
        showToast('Marque o áudio do sistema no seletor para transmitir o som.');
        return;
    }

    const audioAfter = state.loopback;
    if (audioAfter === audioBefore) {
        dropCapture();
    } else {
        state.loopback = null;
        dropCapture();
        state.loopback = audioAfter;
    }
    state.stopping = false;
    state.stream = stream;
    state.channel = channel;
    const card = document.querySelector(`[data-channel="${channel}"]`);
    const preview = card.querySelector('[data-preview]');
    preview.srcObject = stream;
    preview.hidden = false;
    render();

    for (const track of stream.getTracks()) {
        track.addEventListener('ended', () => {
            if (state.channel === channel && !state.stopping) {
                stop();
            }
        });
    }

    try {
        const pending = waitFor((msg) => (msg.type === 'ready' && msg.channel === channel) || msg.type === 'error' || (msg.type === 'stopped' && msg.channel === channel), 15000);
        send({ audio: true, channel, fps, height, type: 'start', width });
        const msg = await pending;
        if (state.stream !== stream) {
            return;
        }
        if (msg.type !== 'ready') {
            throw new Error(msg.message || 'Não foi possível iniciar a transmissão.');
        }
        startRecorder(stream);
        showToast('');
        render();
    } catch (err) {
        if (state.stream !== stream) {
            return;
        }
        sendStop();
        finishStop();
        showToast(err.message || 'Não foi possível iniciar a transmissão.');
    }
}

function sendStop() {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        send({ type: 'stop' });
    }
}

function stop() {
    if (!state.channel || state.stopping) {
        return;
    }
    state.stopping = true;
    releaseDesktopAudio();
    if (state.recorder && state.recorder.state !== 'inactive') {
        state.recorder.ondataavailable = null;
        try {
            state.recorder.stop();
        } catch {
            /* already stopped */
        }
    }
    if (state.stream) {
        for (const track of state.stream.getTracks()) {
            track.stop();
        }
    }
    sendStop();
    render();
}

function render() {
    for (const card of document.querySelectorAll('[data-channel]')) {
        const id = Number(card.dataset.channel);
        const mine = state.channel === id;
        const status = card.querySelector('[data-status]');
        const button = card.querySelector('[data-action]');

        card.querySelector('[data-fps]').disabled = mine || !state.connected || state.picking;

        if (!state.connected) {
            status.textContent = 'Conectando…';
        } else if (mine) {
            status.textContent = 'Transmitindo';
        } else {
            status.textContent = '';
        }

        status.classList.toggle('live', mine && !state.stopping);
        status.classList.remove('busy');

        button.textContent = mine && !state.stopping ? 'Parar' : 'Transmitir';
        button.disabled = state.picking || !state.connected || (mine && state.stopping);
    }
}

document.getElementById('picker-cancel').addEventListener('click', () => closePicker(null));
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && pickerResolver) {
        closePicker(null);
    }
});

document.querySelector('.channels').addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button || button.disabled) {
        return;
    }
    const id = Number(button.closest('[data-channel]').dataset.channel);
    if (state.channel === id && !state.stopping) {
        stop();
    } else {
        transmit(id);
    }
});

connect();
render();
