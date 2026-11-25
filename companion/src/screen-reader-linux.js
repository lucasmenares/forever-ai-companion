export function marker(p, w) {
    const lum = (x, y) => {
        const i = (y * w + x) * 3;
        return Math.floor(
            (p[i] + p[i+1] + p[i+2]) / 3
        );
    };

    const gray = (x, y) => {
        const i = (y * w + x) * 3;
        return Math.abs(p[i] - p[i+1]) < 12
            && Math.abs(p[i+1] - p[i+2]) < 12;
    };

    if (w < 40 || p.length < w * 9 * 3)
        return false;

    const white = lum(1, 1);

    if (white < 60 || !gray(1, 1))
        return false;

    for (let i = 0; i < 8; i++) {
        const x = i * 3 + 1;
        const v = lum(x, 1);

        if (i % 2 === 0) {
            if (Math.abs(v - white) > white / 4
                || !gray(x, 1))
                return false;
        } else if (v > white / 4) {
            return false;
        }
    }

    let prev = -1;

    for (let k = 1; k <= 4; k++) {
        const x = k * 3 + 1;
        if (!gray(x, 4)) return false;

        const v = lum(x, 4);
        if (k > 1 && v < prev + white / 6)
            return false;

        prev = v;
    }

    return true;
}

import { spawn, execFileSync } from 'node:child_process';

export function startLinuxScreenReader({
    onFrame,
    log = () => {},
    captureHeight = 160
}) {
    let child = null;
    let stopped = false;
    let retry = null;
    let seq = 0;
    let tries = 0;
    let visible = false;

    function launch() {
        if (stopped) return;

        try {
            const id = execFileSync('xdotool', [
                'search', '--onlyvisible',
                '--name', '^World of Warcraft$'
            ], { encoding: 'utf8' }).trim().split('\n')[0];

            const info = execFileSync('xwininfo', [
                '-id', id
            ], { encoding: 'utf8' });

            const width = Number(info.match(/Width:\s+(\d+)/)[1]);
            const height = Math.min(
                captureHeight,
                Number(info.match(/Height:\s+(\d+)/)[1])
            );

            const frameSize = width * height * 3;
            let pending = Buffer.alloc(0);

            child = spawn('ffmpeg', [
                '-hide_banner',
                '-loglevel', 'error',
                '-f', 'x11grab',
                '-framerate', '25',
                '-window_id', id,
                '-video_size', width + 'x' + height,
                '-i', process.env.DISPLAY || ':0',
                '-an',
                '-pix_fmt', 'rgb24',
                '-f', 'rawvideo',
                'pipe:1'
            ], { stdio: ['ignore', 'pipe', 'pipe'] });

            visible = false;
            tries = 0;

            child.stdout.on('data', chunk => {
                pending = Buffer.concat([pending, chunk]);

                while (pending.length >= frameSize) {
                    const data = pending.subarray(0, frameSize);
                    pending = pending.subarray(frameSize);

                    if (!marker(data, width)) {
                        visible = false;
                        continue;
                    }

                    if (!visible) {
                        visible = true;
                        seq++;
                        tries = 0;
                    }

                    if (tries < 3) {
                        tries++;
                        try {
                            onFrame({
                                seq,
                                attempt: tries,
                                width,
                                height,
                                channels: 3,
                                data
                            });
                        } catch (e) {
                            log(e.message);
                        }
                    }
                }
            });

            child.stderr.on('data', d => {
                log(String(d).trim());
            });

            child.on('error', e => log(e.message));

            child.on('close', () => {
                child = null;
                if (!stopped)
                    retry = setTimeout(launch, 3000);
            });

            log('Linux screen reader: ' + width + 'x' + height);

        } catch (e) {
            log(e.message);
            if (!stopped)
                retry = setTimeout(launch, 3000);
        }
    }

    launch();

    return {
        stop() {
            stopped = true;
            clearTimeout(retry);
            if (child) child.kill();
        }
    };
}
