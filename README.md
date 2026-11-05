# ESPHomeXYPlotter

A web UI for streaming G-code to an ESP32 XY pen plotter over TCP.

![image](https://github.com/user-attachments/assets/293853b9-9fb2-4a4c-8790-dddde30bbc4d)

The plotter firmware should speak a GRBL-compatible protocol over a raw TCP socket: one command per line, answered with `ok` or `error:N`.

**Setting up the plotter side:** see [docs/esp-setup.md](docs/esp-setup.md) for wiring, flashing GRBL, and the ESPHome WiFi-to-serial bridge config in [`firmware/esphome/`](firmware/esphome/).

## Features

- **Toolpath preview**: pen-down and pen-up moves (arcs included), bounds and size. Plotted lines turn blue as the job progresses. Scroll to zoom, drag to pan, double-click to fit.
- **The job runs on the server**: closing or sleeping the browser tab does not stop a plot. Every open tab or device shows the same live state.
- **Correct flow control**, two modes:
  - **Safe** (default): one line in flight, the next sent after `ok`. Works with any firmware that answers each line.
  - **Fast**: GRBL's character-counting protocol keeps the controller's 128-byte receive buffer full, so the motion planner never runs dry. In a test with 15 ms of simulated WiFi latency, a 2,182-line drawing streamed in 6 s instead of 36 s. Choose it in ⚙ Settings → Streaming.

  TCP data is split into lines before parsing, so responses that arrive merged or split don't confuse it.
- **Edit G-code in the browser**: in the G-code tab, click **Edit** (it opens at the "From line" line), change the text and watch the preview update, then **Apply** (`Ctrl+S`) to make it the job. **Download** saves the current G-code to a file.
- **Pause / resume / stop**, and start from any line (click a line in the G-code tab). On resume, the pen is lifted, moved back to where the file left off, and the pen, units, distance mode and feed rate are restored.
- **Recovery**: if the connection drops, the server reconnects with backoff and can resume the job automatically. If the controller reset, the job stays paused, because the position may be lost.
- **G-code errors pause the job** at the failing line, with the GRBL error explained. You can skip the line and resume.
- **Machine controls**: jog with a 0.1/1/10/50 mm step or the arrow keys (can be turned off in Settings), pen up/down, set zero, go to zero, Hold `!`, Cycle `~`, Reset `Ctrl-X`, Unlock `$X`, and the settings dump `$$`.
- **Pen position on the preview**: a crosshair shows where the pen is. Without status reports, the server estimates it from the commands the plotter acknowledged (jogs, go/set zero, box, frame, console, jobs), shown as `≈ X … Y …`. The estimate assumes X0 Y0 when you connect, and is lost after homing (`$H`) or `G28`/`G30` until the next absolute XY move.
- **Box & frame**: trace the drawing's bounds with the pen up to check placement on the paper, or draw a box.
- **Console** with command history (↑/↓). Job traffic is hidden unless you turn it on.
- Works offline (no CDN), and the layout adapts to phones and tablets.

## Getting started

Requires Node.js 22 or newer.

```bash
npm install
npm start          # http://localhost:3000
```

Enter the plotter's IP and port in the top bar and click **Connect**. Then open or drop a `.gcode` file and press **Start**.

**No plotter at hand?** Run the simulator in a second terminal (`npm run simulator`) and connect to `127.0.0.1:1234`.

### Running from VS Code

Open the folder in VS Code and press **F5**, or pick a configuration in *Run and Debug*:

| Configuration | What it does |
| --- | --- |
| **Start server** | Runs the server with the debugger attached and opens the UI in your browser. |
| **Start server (auto-restart on changes)** | Same, restarting whenever a file changes. |
| **GRBL simulator (no hardware)** | Fake plotter on `127.0.0.1:1234`. |
| **Server + simulator** | Both at once, to try everything without hardware. |
| **Run tests** | The test suite, under the debugger. |

The same things are available as tasks (*Terminal → Run Task*), along with *ESPHome: validate config / flash / show logs*. `Ctrl+Shift+B` starts the dev server. VS Code will also suggest the ESPHome extension for editing the firmware YAML.

### Configuration

Copy `.env.example` to `.env` to change these:

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Interface the UI listens on. Use `127.0.0.1` to allow this computer only. |
| `PORT` | `3000` | Web UI port. |
| `ALLOWED_TARGETS` | `private` | Plotter addresses the server may connect to: `private` (LAN/loopback), `any`, or a comma-separated host list. |
| `LINE_TIMEOUT_MS` | `300000` | Pause the job if a line gets no `ok` within this time. |
| `CONNECT_TIMEOUT_MS` | `5000` | TCP connect timeout. |
| `MAX_UPLOAD_MB` | `50` | Largest G-code file accepted. |

Per-browser preferences are in the ⚙ dialog: pen up/down commands, jog method, axis inversion and status polling. They're stored in `localStorage`.

> **Jog method.** The default sends `G91 G1 …` followed by `G90`, which works with any GRBL-like firmware. If your firmware supports GRBL 1.1 `$J=` jogging, select it in Settings.
>
> **Status polling** sends GRBL's realtime `?` to show the real position instead of the estimate. Leave it off unless your firmware supports it.
>
> **Invert Y** is on by default, because the previous version sent `Y-10` for the "Y+" button.

## Project layout

```
docs/esp-setup.md          ESP32 + GRBL hardware and firmware setup
firmware/esphome/          ESPHome WiFi <-> serial bridge config (+ secrets template)
tools/grbl-simulator.js    Fake GRBL plotter for development without hardware
.vscode/                   Launch configurations and tasks
shared/gcode.js            G-code parsing shared by server and browser: cleaning, modal state, preview geometry, resume preamble
src/
  server.js                Express + WebSocket wiring, entry point
  config.js                Environment configuration
  transport/tcp-connection.js   TCP socket with line framing
  grbl/protocol.js         Parse ok / error:N / ALARM / <status> / [MSG] / welcome banner
  grbl/controller.js       Command queue + flow control, realtime commands, auto-reconnect, status polling
  job/runner.js            Streams a file: start/pause/resume/stop, error & disconnect handling, auto-resume
  api/routes.js            REST API (all actions)
  api/ws.js                WebSocket push of state, progress, machine status and log
  api/targets.js           Validates which hosts the server may connect to
  mcp/server.js            MCP server (stdio) for AI agents, a client of the REST API
  mcp/draw.js, render.js   Polylines -> G-code; toolpath -> PNG preview
public/
  index.html, css/app.css
  js/main.js               UI wiring and rendering
  js/preview.js            Canvas toolpath preview
  js/code-list.js          Virtualised G-code listing
  js/terminal.js           Console + command history
  js/socket.js, settings.js, util.js
test/                      node:test suites against a fake GRBL TCP server
```

## AI agent control (MCP)

[`src/mcp/server.js`](src/mcp/server.js) is a dependency-free [MCP](https://modelcontextprotocol.io) server (stdio) that gives an AI agent full control of the plotter. It talks to the running web server's API, so keep `npm start` running. Everything the agent does shows up live in the browser.

- **Claude Code**: the included [`.mcp.json`](.mcp.json) registers it automatically when you open this folder. From anywhere else, run `claude mcp add xy-plotter -- node /path/to/ESPHomeXYPlotter/src/mcp/server.js`.
- **Other clients**: command `node`, args `["/path/to/src/mcp/server.js"]`.

| Tool | |
| --- | --- |
| `get_state` | Connection, machine status and job progress |
| `connect` / `disconnect` | Open or close the TCP connection |
| `send_commands` | Any lines, including GRBL `$` commands (`$$`, `$X`, `$H`, `$N=…`) |
| `realtime` | hold / resume / status / reset |
| `draw_polylines` | Turn `[[x,y],…]` polylines (mm) into G-code with pen up/down and load it as the job |
| `load_gcode` / `get_gcode` / `unload_job` | Raw G-code jobs |
| `preview` | PNG of the toolpath (black = pen down, grey = travel, grid and origin axes) |
| `start_job` / `pause_job` / `resume_job` / `stop_job` | Run control |
| `wait_for_job` | Block until the job finishes or pauses |

`draw_polylines` and `load_gcode` return the preview image, so the agent can check its drawing before it calls `start_job`. Pen commands and the drawing feed come from `PEN_UP`, `PEN_DOWN` and `DRAW_FEED` in `.env` (see `.env.example`). To try it without hardware, run `npm run simulator` and ask the agent to connect to `127.0.0.1:1234`.

## API

The REST API is used for actions. The WebSocket (`/ws`) only pushes updates from server to browser.

| Method & path | Body | |
| --- | --- | --- |
| `GET /api/state` | | Connection and job snapshot |
| `POST /api/connect` | `{host, port, autoReconnect?, statusPollMs?, streaming?, rxBufferSize?}` | `streaming`: `"send-response"` or `"char-count"` |
| `POST /api/disconnect` | | |
| `PATCH /api/connection/options` | `{autoReconnect?, statusPollMs?, streaming?, rxBufferSize?}` | Takes effect immediately |
| `POST /api/commands` | `{commands: string[]}` | Runs the commands in order and stops at the first error. Refused while a job is running. |
| `POST /api/realtime` | `{command: "hold" \| "resume" \| "status" \| "reset"}` | |
| `POST /api/job?name=file.gcode` | G-code as `text/plain` | Load a job |
| `GET /api/job/gcode` / `DELETE /api/job` | | Get or unload the loaded job |
| `POST /api/job/start` | `{fromLine?}` (0-based) | |
| `POST /api/job/pause` · `/resume` · `/stop` | | |
| `POST /api/job/line` | `{line}` | Move the resume point while paused |
| `PATCH /api/job/options` | `{autoResume}` | |

Example: `curl -X POST localhost:3000/api/commands -H 'Content-Type: application/json' -d '{"commands":["$$"]}'`

## Development

```bash
npm run dev        # restart on file changes
npm run simulator  # fake plotter on 127.0.0.1:1234
npm test           # unit + integration tests (no hardware needed)
```
