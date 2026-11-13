const count = Number(location.pathname.slice(1));

function mount(sources) {
    document.body.dataset.count = String(count);
    for (let id = 1; id <= count; id += 1) {
        const frame = document.createElement('iframe');
        frame.src = sources[id] || 'about:blank';
        frame.title = `HTTPS_${id}`;
        frame.allow = 'autoplay; fullscreen; encrypted-media';
        frame.allowFullscreen = true;
        document.body.append(frame);
    }
}

if ([1, 2, 3].includes(count)) {
    fetch('/players')
        .then((res) => res.json())
        .then(mount)
        .catch(() => {});
}
