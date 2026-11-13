const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const PORT = Number(process.env.PORT) || 3000;
const BITRATE = '8000k';
const GOP = 2;
const publicDir = path.join(__dirname, 'public');
const clients = new Set();
const sessions = new Map();
let ffmpegOk = false;

function buildIngestUrl(base, streamKey) {
    const key = String(streamKey || '').trim();
    if (!key) {
        throw new Error('Stream key ausente.');
    }

    const url = new URL(String(base).trim());
    if (url.protocol !== 'rtmps:' && url.protocol !== 'rtmp:') {
        throw new Error('O endereço precisa ser RTMP ou RTMPS.');
    }

    if (!url.port) {
        url.port = url.protocol === 'rtmps:' ? '443' : '1935';
    }

    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length === 0) {
        parts.push('app');
    }
    parts.push(key);
    url.pathname = `/${parts.map((part) => encodeURIComponent(part)).join('/')}`;
    url.search = '';
    url.hash = '';
    return url.toString();
}

function outputArgs(width, height, fps, withAudio = false) {
    const x264 = ['nal-hrd=cbr', 'force-cfr=1', 'filler=1', `keyint=${GOP}`, `min-keyint=${GOP}`, 'scenecut=0', 'bframes=0', 'open-gop=0'].join(':');

    return [
        '-vf',
        `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${fps},setpts=PTS-STARTPTS`,
        ...(withAudio ? ['-map', '0:v:0', '-map', '0:a:0', '-af', 'aresample=async=1:first_pts=0'] : []),
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-tune',
        'zerolatency',
        '-profile:v',
        'high',
        '-level:v',
        '4.2',
        '-pix_fmt',
        'yuv420p',
        '-fps_mode',
        'cfr',
        '-g',
        String(GOP),
        '-bf',
        '0',
        '-b:v',
        BITRATE,
        '-minrate',
        BITRATE,
        '-maxrate',
        BITRATE,
        '-bufsize',
        BITRATE,
        '-forced-idr',
        '1',
        '-x264-params',
        x264,
        ...(withAudio ? ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2'] : ['-an']),
        '-muxdelay',
        '0',
        '-muxpreload',
        '0',
        '-flvflags',
        'no_duration_filesize',
    ];
}

function buildFfmpegArgs(width, height, fps, ingestUrl, withAudio = false) {
    return [
        '-hide_banner',
        '-loglevel',
        'warning',
        '-fflags',
        '+genpts',
        '-probesize',
        '1000000',
        '-analyzeduration',
        '500000',
        '-i',
        'pipe:0',
        ...outputArgs(width, height, fps, withAudio),
        '-f',
        'flv',
        ingestUrl,
    ];
}

function redact(text) {
    let out = String(text).replace(/rtmps?:\/\/\S+/gi, 'rtmps://[redacted]');
    for (const id of [1, 2, 3]) {
        const key = (process.env[`KEY_${id}`] || '').trim();
        if (key) {
            out = out.split(key).join('[redacted]');
        }
    }
    return out;
}

function send(ws, payload) {
    if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(payload));
    }
}

function slotsPayload() {
    return { channels: [1, 2, 3].map((id) => ({ busy: sessions.has(id), id })), type: 'slots' };
}

function broadcastSlots() {
    const payload = JSON.stringify(slotsPayload());
    for (const ws of clients) {
        if (ws.readyState === ws.OPEN) {
            ws.send(payload);
        }
    }
}

function ingestFor(id) {
    const base = (process.env[`RTMPS_${id}`] || '').trim();
    const key = (process.env[`KEY_${id}`] || '').trim();
    if (!base || !key) {
        return { error: `Canal ${id} está sem RTMPS_${id} ou KEY_${id} no ambiente.` };
    }
    try {
        return { url: buildIngestUrl(base, key) };
    } catch {
        return { error: `Endereço do canal ${id} inválido.` };
    }
}

function sessionBySocket(ws) {
    for (const session of sessions.values()) {
        if (session.ws === ws) {
            return session;
        }
    }
    return null;
}

function stopSession(id) {
    const session = sessions.get(id);
    if (!session || session.stopping) {
        return;
    }
    session.stopping = true;
    const stdin = session.ffmpeg.stdin;
    if (stdin && !stdin.destroyed) {
        stdin.end();
    }
    session.killTimer = setTimeout(() => {
        if (session.ffmpeg.exitCode === null && !session.ffmpeg.killed) {
            session.ffmpeg.kill('SIGKILL');
        }
    }, 3000);
}

function startSession(ws, channel, width, height, fps, withAudio) {
    const ingest = ingestFor(channel);
    if (ingest.error) {
        send(ws, { message: ingest.error, type: 'error' });
        return;
    }

    const ffmpeg = spawn('ffmpeg', buildFfmpegArgs(width, height, fps, ingest.url, withAudio), { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });

    const session = { bytes: 0, ffmpeg, id: channel, killTimer: null, lastError: '', lastLog: Date.now(), settled: false, stopping: false, ws };
    sessions.set(channel, session);

    function settle(notify) {
        if (session.settled) {
            return;
        }
        session.settled = true;
        clearTimeout(session.killTimer);
        if (sessions.get(channel) === session) {
            sessions.delete(channel);
        }
        notify();
        broadcastSlots();
    }

    ffmpeg.on('error', (err) => {
        const missing = err.code === 'ENOENT';
        settle(() => {
            send(ws, { message: missing ? 'FFmpeg não está instalado ou não está no PATH.' : 'Não foi possível iniciar o FFmpeg.', type: 'error' });
        });
    });

    ffmpeg.stdin.on('error', (err) => {
        if (err.code !== 'EPIPE') {
            console.error(redact(err.message));
        }
    });

    ffmpeg.stderr.on('data', (chunk) => {
        const line = redact(chunk.toString());
        session.lastError = line.trim().slice(-500);
        process.stderr.write(`[canal ${channel}] ${line}`);
    });

    ffmpeg.on('exit', (code, signal) => {
        console.log(`Canal ${channel} encerrou (${code ?? signal})`);
        settle(() => {
            if (ws.readyState !== ws.OPEN) {
                return;
            }
            if (session.stopping || code === 0) {
                send(ws, { channel, type: 'stopped' });
            } else {
                send(ws, { message: session.lastError || `A transmissão caiu (código ${code ?? signal}).`, type: 'error' });
            }
        });
    });

    console.log(`Canal ${channel} abrindo ${width}x${height} ${fps}fps CBR 8000kbps GOP 2${withAudio ? ' com áudio' : ''}`);
    send(ws, { channel, type: 'ready' });
    broadcastSlots();
}

function onControl(ws, msg) {
    if (!msg || typeof msg !== 'object') {
        return;
    }

    if (msg.type === 'stop') {
        const session = sessionBySocket(ws);
        if (session) {
            stopSession(session.id);
        }
        return;
    }

    if (msg.type !== 'start') {
        return;
    }

    const channel = Number(msg.channel);
    const width = 1920;
    const height = 1080;
    const fps = Number(msg.fps);

    if (![1, 2, 3].includes(channel)) {
        send(ws, { message: 'Canal inválido.', type: 'error' });
        return;
    }
    if (![30, 60].includes(fps)) {
        send(ws, { message: 'Taxa de quadros inválida.', type: 'error' });
        return;
    }
    if (!ffmpegOk) {
        send(ws, { message: 'FFmpeg não está instalado ou não está no PATH.', type: 'error' });
        return;
    }
    if (sessionBySocket(ws)) {
        send(ws, { message: 'Esta conexão já está transmitindo.', type: 'error' });
        return;
    }
    if (sessions.has(channel)) {
        send(ws, { message: 'Canal ocupado.', type: 'error' });
        return;
    }

    startSession(ws, channel, width, height, fps, msg.audio === true);
}

function writeChunk(ws, chunk) {
    const session = sessionBySocket(ws);
    if (!session || session.stopping) {
        return;
    }
    const stdin = session.ffmpeg.stdin;
    if (!stdin || stdin.destroyed) {
        return;
    }
    session.bytes += chunk.length;
    const now = Date.now();
    if (now - session.lastLog >= 5000) {
        console.log(`Canal ${session.id}: ${(session.bytes / 1e6).toFixed(1)} MB recebidos`);
        session.lastLog = now;
    }
    stdin.write(chunk);
}

function checkFfmpeg() {
    return new Promise((resolve) => {
        const probe = spawn('ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true });
        probe.on('error', () => resolve(false));
        probe.on('exit', (code) => resolve(code === 0));
    });
}

const app = express();

function sendPage(res, file) {
    res.set('Cache-Control', 'no-store');
    res.sendFile(file);
}

app.get('/', (_req, res) => sendPage(res, path.join(publicDir, 'index.html')));
app.get('/stream', (_req, res) => sendPage(res, path.join(publicDir, 'stream.html')));
function playerSources() {
    const sources = {};
    for (const id of [1, 2, 3]) {
        const raw = (process.env[`HTTPS_${id}`] || '').trim();
        let href = '';
        try {
            const url = new URL(raw);
            if (url.protocol === 'https:' || url.protocol === 'http:') {
                href = url.href;
            }
        } catch {
            href = '';
        }
        sources[id] = href;
    }
    return sources;
}

app.get(['/1', '/2', '/3'], (_req, res) => sendPage(res, path.join(publicDir, 'play.html')));
app.get('/players', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(playerSources());
});
app.use(express.static(publicDir, { etag: false, maxAge: 0 }));

const server = http.createServer(app);
const wss = new WebSocketServer({ maxPayload: 8 * 1024 * 1024, path: '/ws', server });

wss.on('connection', (ws) => {
    clients.add(ws);
    send(ws, slotsPayload());

    ws.on('message', (data, isBinary) => {
        if (isBinary) {
            writeChunk(ws, data);
            return;
        }
        try {
            onControl(ws, JSON.parse(data.toString()));
        } catch {
            send(ws, { message: 'Mensagem inválida.', type: 'error' });
        }
    });

    ws.on('close', () => {
        clients.delete(ws);
        const session = sessionBySocket(ws);
        if (session) {
            stopSession(session.id);
        }
    });
});

function shutdown() {
    for (const id of [...sessions.keys()]) {
        stopSession(id);
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 4000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

checkFfmpeg().then((ok) => {
    ffmpegOk = ok;
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`vdz em http://localhost:${PORT}`);
        console.log(`Transmitir em http://localhost:${PORT}/stream`);
        if (!ok) {
            console.error('FFmpeg não encontrado no PATH. A transmissão não vai iniciar.');
        }
    });
});
