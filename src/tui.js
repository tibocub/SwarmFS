import terminalKit from 'terminal-kit';
import * as cmd from './commands.js';

const term = terminalKit.terminal;

function formatBar(progress, width) {
  const p = Math.max(0, Math.min(1, progress || 0));
  const filled = Math.round(p * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

function safeString(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function writeFixed(x, y, width, text) {
  const s = (text ?? '').toString();
  term.moveTo(x, y);
  term((s.length > width ? s.slice(0, width) : s.padEnd(width, ' ')));
}

export async function startTui(swarmfs) {
  swarmfs.open();

  let resolveStopped;
  const stoppedPromise = new Promise((resolve) => {
    resolveStopped = resolve;
  });

  const state = {
    logs: [],
    maxLogs: 2000,
    peerCount: 0,
    downloads: new Map(), // id -> { title, totalChunks, downloadedChunks, startedAt, status }
    renderScheduled: false,
    inputActive: false,
    stopped: false
  };

  const pushLog = (line) => {
    state.logs.push(safeString(line));
    if (state.logs.length > state.maxLogs) {
      state.logs.splice(0, state.logs.length - state.maxLogs);
    }
    scheduleRender();
  };

  const originalConsole = {
    log: console.log,
    error: console.error,
    warn: console.warn
  };

  const stringifyArgs = (args) =>
    args
      .map((a) => {
        if (typeof a === 'string') return a;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(' ');

  console.log = (...args) => pushLog(stringifyArgs(args));
  console.error = (...args) => pushLog(stringifyArgs(args));
  console.warn = (...args) => pushLog(stringifyArgs(args));

  const leftRatio = 0.65;
  const gutter = 1;

  let frameDirty = true;

  function layout() {
    const width = term.width || 80;
    const height = term.height || 24;

    const statusHeight = 1;
    const promptHeight = 1;
    const mainHeight = Math.max(1, height - statusHeight - promptHeight);

    const leftWidth = Math.max(20, Math.floor(width * leftRatio) - gutter);
    const rightWidth = Math.max(20, width - leftWidth - gutter);

    return {
      width,
      height,
      mainHeight,
      statusY: mainHeight + 1,
      promptY: mainHeight + statusHeight + 1,
      left: { x: 1, y: 1, w: leftWidth, h: mainHeight },
      right: { x: leftWidth + gutter + 1, y: 1, w: rightWidth, h: mainHeight }
    };
  }

  function scheduleRender() {
    if (state.renderScheduled || state.stopped) {
      return;
    }
    state.renderScheduled = true;
    setTimeout(() => {
      state.renderScheduled = false;
      render();
    }, 33);
  }

  function drawBox(x, y, w, h, title) {
    if (w < 2 || h < 2) return;

    term.moveTo(x, y);
    term('┌' + '─'.repeat(w - 2) + '┐');

    if (title) {
      const t = ` ${title} `;
      const maxTitle = Math.max(0, w - 4);
      term.moveTo(x + 2, y);
      term(t.slice(0, maxTitle));
    }

    for (let row = 1; row < h - 1; row++) {
      term.moveTo(x, y + row);
      term('│');
      term.moveTo(x + w - 1, y + row);
      term('│');
    }

    term.moveTo(x, y + h - 1);
    term('└' + '─'.repeat(w - 2) + '┘');
  }

  function renderLogsPane(box) {
    const innerW = Math.max(1, box.w - 2);
    const innerH = Math.max(1, box.h - 2);
    const lines = state.logs.slice(-innerH);

    for (let i = 0; i < innerH; i++) {
      const line = lines[i] || '';
      writeFixed(box.x + 1, box.y + 1 + i, innerW, line);
    }
  }

  function renderDownloadsPane(box) {
    const innerW = Math.max(1, box.w - 2);
    const innerH = Math.max(1, box.h - 2);

    const items = Array.from(state.downloads.values());
    const maxItems = Math.floor(innerH / 3) || 1;
    const view = items.slice(-maxItems);

    let row = 0;
    for (const d of view) {
      const title = safeString(d.title);
      const total = d.totalChunks || 0;
      const done = d.downloadedChunks || 0;
      const pct = total > 0 ? done / total : 0;

      const titleLine = `${title}`.slice(0, innerW);
      const counter = total > 0 ? `${done}/${total}` : '';

      writeFixed(box.x + 1, box.y + 1 + row, innerW, titleLine);
      row++;

      const barWidth = Math.max(10, innerW - (counter.length ? counter.length + 1 : 0));
      const bar = formatBar(pct, barWidth);
      const barLine = counter.length ? `${bar} ${counter}` : bar;
      writeFixed(box.x + 1, box.y + 1 + row, innerW, barLine);
      row++;

      const statusLine = safeString(d.status || '').slice(0, innerW);
      writeFixed(box.x + 1, box.y + 1 + row, innerW, statusLine);
      row++;

      if (row >= innerH) break;
    }

    while (row < innerH) {
      writeFixed(box.x + 1, box.y + 1 + row, innerW, '');
      row++;
    }
  }

  function renderStatusBar(y, width) {
    const left = ` peers: ${state.peerCount} `;
    const right = ' [Ctrl-C] Exit  [?] Help ';
    const middleSpace = Math.max(1, width - left.length - right.length);
    term.moveTo(1, y);
    term.inverse(left + ' '.repeat(middleSpace) + right);
    term(' '.repeat(Math.max(0, width - (left.length + middleSpace + right.length))));
    term.styleReset();
  }

  function renderPromptLine(y) {
    writeFixed(1, y, Math.max(1, (term.width || 80)), '');
    term.moveTo(1, y);
    term('> ');
  }

  function renderFrame() {
    const l = layout();

    term.clear();
    drawBox(l.left.x, l.left.y, l.left.w, l.left.h, 'Logs');
    drawBox(l.right.x, l.right.y, l.right.w, l.right.h, 'Downloads');

    renderStatusBar(l.statusY, l.width);
    if (!state.inputActive) {
      renderPromptLine(l.promptY);
    }

    frameDirty = false;
  }

  function render() {
    if (state.stopped) {
      return;
    }

    const l = layout();

    if (frameDirty) {
      renderFrame();
    }

    renderLogsPane(l.left);
    renderDownloadsPane(l.right);

    renderStatusBar(l.statusY, l.width);
    if (!state.inputActive) {
      renderPromptLine(l.promptY);
    }
  }

  function restoreConsole() {
    console.log = originalConsole.log;
    console.error = originalConsole.error;
    console.warn = originalConsole.warn;
  }

  function stop() {
    if (state.stopped) {
      return;
    }

    state.stopped = true;
    restoreConsole();

    term.grabInput(false);
    term.hideCursor(false);
    term.styleReset();
    term.clear();
    term('\n');

    if (resolveStopped) {
      resolveStopped();
      resolveStopped = null;
    }
  }

  async function autoJoin() {
    try {
      const topics = await swarmfs.db.getAutoJoinTopics();
      for (const t of topics) {
        try {
          pushLog(`Auto-joining ${t.name}...`);
          await cmd.topicJoinCommand(swarmfs, t.name);
        } catch (e) {
          pushLog(`Auto-join failed for ${t.name}: ${e.message}`);
        }
      }
    } catch (e) {
      pushLog(`Auto-join error: ${e.message}`);
    }
  }

  function hookNetworkEvents() {
    if (!swarmfs.network) {
      return;
    }

    const updatePeers = () => {
      try {
        state.peerCount = swarmfs.network.getStats().connections;
      } catch {
        state.peerCount = 0;
      }
      scheduleRender();
    };

    updatePeers();
    swarmfs.network.on('peer:connect', () => updatePeers());
    swarmfs.network.on('peer:disconnect', () => updatePeers());
  }

  async function runCommandLine(line) {
    const trimmed = safeString(line);
    if (!trimmed) {
      return;
    }

    if (trimmed === 'exit' || trimmed === 'quit') {
      stop();
      swarmfs.close();
      return;
    }

    if (trimmed === '?' || trimmed === 'help') {
      pushLog('Commands: add/status/verify/info/stats');
      pushLog('Commands: topic create/list/info/share/unshare/join/leave');
      pushLog('Commands: request/browse/download/network');
      pushLog('Type exit to quit');
      return;
    }

    const parts = trimmed.split(' ');
    const name = parts[0];
    const args = parts.slice(1);

    if (name === 'download' && args.length >= 3) {
      const [topicName, merkleRoot, outputPath] = args;
      const id = `${merkleRoot}:${Date.now()}`;

      state.downloads.set(id, {
        title: `${merkleRoot.substring(0, 16)}...`,
        totalChunks: 0,
        downloadedChunks: 0,
        startedAt: Date.now(),
        status: 'starting'
      });
      scheduleRender();

      swarmfs
        .downloadFile(topicName, merkleRoot, outputPath, {
          onProgress: (info) => {
            const d = state.downloads.get(id);
            if (!d) return;
            if (typeof info.totalChunks === 'number') d.totalChunks = info.totalChunks;
            if (typeof info.downloadedChunks === 'number') d.downloadedChunks = info.downloadedChunks;
            d.status = 'downloading';
            scheduleRender();
          }
        })
        .then(() => {
          const d = state.downloads.get(id);
          if (d) {
            d.status = 'done';
            scheduleRender();
          }
        })
        .catch((e) => {
          const d = state.downloads.get(id);
          if (d) {
            d.status = `error: ${e.message}`;
            scheduleRender();
          }
        });

      return;
    }

    const commandFunc = cmd.getCommand(name);
    if (!commandFunc) {
      pushLog(`Command not found: ${name}`);
      return;
    }

    commandFunc(swarmfs, ...args, {}).catch((e) => pushLog(`Error: ${e.message}`));
  }

  async function promptLoop() {
    if (state.stopped) {
      return;
    }

    const l = layout();
    const x = 3;
    const y = l.promptY;
    const w = Math.max(10, l.width - 2);

    state.inputActive = true;
    term.moveTo(x, y);

    term.inputField({
      x,
      y,
      width: w,
      cancelable: true
    }, (err, input) => {
      state.inputActive = false;

      if (state.stopped) {
        return;
      }

      if (err) {
        scheduleRender();
        return promptLoop();
      }

      runCommandLine(input).finally(() => {
        scheduleRender();
        promptLoop();
      });
    });
  }

  term.clear();
  term.grabInput({ mouse: false });
  term.on('key', (name) => {
    if (name === 'CTRL_C') {
      stop();
      swarmfs.close();
      return;
    }
  });

  term.on('resize', () => scheduleRender());

  term.on('resize', () => {
    frameDirty = true;
    scheduleRender();
  });

  await autoJoin();
  hookNetworkEvents();

  frameDirty = true;
  render();
  promptLoop();

  return stoppedPromise;
}
