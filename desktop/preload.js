const { contextBridge, ipcRenderer } = require('electron');

let pcmListener = null;

ipcRenderer.on('rdz-pcm', (_event, bytes) => {
    if (pcmListener) {
        pcmListener(bytes);
    }
});

contextBridge.exposeInMainWorld('rdzDesktop', {
    arm(sourceId) {
        return ipcRenderer.sendSync('rdz-arm', sourceId);
    },
    beginAudio(sourceId) {
        return ipcRenderer.invoke('rdz-begin-audio', sourceId);
    },
    listWindows() {
        return ipcRenderer.invoke('rdz-list-windows');
    },
    onPcm(listener) {
        pcmListener = listener;
        return () => {
            if (pcmListener === listener) {
                pcmListener = null;
            }
        };
    },
    stopAudio() {
        return ipcRenderer.invoke('rdz-stop-audio');
    },
});
