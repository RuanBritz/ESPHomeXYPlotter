# Setting up the ESP32

This guide sets up the plotter side: an ESP32 running **ESPHome** as a WiFi-to-serial bridge, in front of a **GRBL** motion controller. The web UI talks to the plotter over TCP port `1234`.

> **Check this matches your build.** The repository doesn't include the original firmware. This guide follows the setup the project name and defaults point to (ESPHome, port 1234, GRBL commands). If your ESP32 runs the motion firmware itself, see [Alternative: GRBL on the ESP32 itself](#alternative-grbl-on-the-esp32-itself).

```
 Browser ──HTTP/WS──▶ Node server (this repo) ──TCP :1234──▶ ESP32 (ESPHome stream_server)
                                                                │ UART 115200
                                                                ▼
                                             GRBL controller (e.g. Arduino Uno + CNC shield)
                                                                │
                                                     X/Y steppers + pen (servo/solenoid)
```

The ESP32 only forwards bytes. All G-code handling happens in GRBL, and all job logic in the Node server.

---

## 1. Hardware

| Part | Notes |
| --- | --- |
| ESP32 dev board | Any ESP32 board with a free hardware UART (e.g. ESP32-DevKitC / `esp32dev`). |
| GRBL controller | Arduino Uno + CNC Shield v3 with A4988/DRV8825/TMC drivers is the usual choice. |
| Level shifting | A bidirectional logic level converter, or a 1 kΩ / 2 kΩ resistor divider (see wiring). |
| Power | Motor supply for the shield (typically 12 V), and a 5 V supply for the ESP32 (USB or a buck converter). |
| Pen actuator | Servo, solenoid or Z stepper. See [Pen lift](#pen-lift). |

## 2. Wiring

| ESP32 | | GRBL board (Uno) | Notes |
| --- | --- | --- | --- |
| GPIO17 (TX2) | → | D0 (RX) | 3.3 V into a 5 V input usually works; a level shifter is more reliable. |
| GPIO16 (RX2) | ← | D1 (TX) | **Must be level shifted**: the Uno outputs 5 V and the ESP32 pins are 3.3 V only. A 1 kΩ (series) / 2 kΩ (to GND) divider is enough. |
| GND | — | GND | **A common ground is required.** |

The pins can be changed in the `substitutions:` block of the config.

Important:

- **Unplug the Uno's USB cable while using the bridge.** The Uno's USB-serial chip shares D0/D1, and both would drive the line at once.
- **Disconnect the ESP from D0/D1 when flashing GRBL** over USB, for the same reason.
- Don't power the ESP32 from the Uno's 5 V pin if you can avoid it. WiFi current spikes can brown out both boards. Use a separate 5 V supply with a shared ground.

## 3. Flash GRBL onto the controller

1. Install the Arduino IDE.
2. Download GRBL 1.1 from <https://github.com/gnea/grbl> and add the `grbl` folder as a library (*Sketch → Include Library → Add .ZIP Library*).
3. Open *File → Examples → grbl → grblUpload*, select your board and port, and upload.
4. In the Serial Monitor (115200 baud, "Both NL & CR"), you should see `Grbl 1.1h ['$' for help]`. Type `$$` to list its settings.

### Basic GRBL settings

The values below are **examples**. Calculate yours from your mechanics:
`steps/mm = (motor steps per rev × microsteps) / (belt pitch × pulley teeth)`, e.g. `200 × 16 / (2 mm × 20) = 80`.

| Setting | Example | Meaning |
| --- | --- | --- |
| `$100` / `$101` | `80` | X / Y steps per mm |
| `$110` / `$111` | `5000` | X / Y max rate, mm/min |
| `$120` / `$121` | `500` | X / Y acceleration, mm/s² |
| `$130` / `$131` | `300` / `220` | Max travel, mm (used by soft limits) |
| `$3` | `0` | Direction invert mask: fix an axis that moves the wrong way |
| `$20` / `$21` / `$22` | `0` | Soft limits / hard limits / homing; enable only if you have limit switches |

Send a setting as e.g. `$100=80`. GRBL stores it in EEPROM. You can also do this later from the web UI console.

### Pen lift

The web UI sends **`M3 S1000`** for pen down and **`M5`** for pen up by default. You can change both in ⚙ Settings, and drawings should use the same commands. How those commands move the pen depends on your controller:

- **Solenoid or relay:** wire it to the spindle-enable output, so M3 turns it on and M5 off.
- **Hobby servo:** stock GRBL's spindle PWM runs at about 1 kHz, but servos need 50 Hz pulses. Use a GRBL variant built for servo pen plotters, or an external servo driver controlled by the spindle output.
- **Z-axis stepper:** set the pen commands to something like `G0 Z5` (up) and `G0 Z0` (down). The preview treats Z ≤ 0 as pen down.

## 4. Flash ESPHome onto the ESP32

The config is in [`firmware/esphome/xy-plotter-bridge.yaml`](../firmware/esphome/xy-plotter-bridge.yaml). It uses the [`stream_server`](https://github.com/oxan/esphome-stream-server) component to expose the UART on a TCP port.

1. **Install ESPHome**, either `pip install esphome` or the ESPHome add-on / dashboard in Home Assistant.
2. **Create the secrets file:**
   ```bash
   cd firmware/esphome
   cp secrets.example.yaml secrets.yaml   # secrets.yaml is git-ignored
   ```
   Fill in your WiFi details, a fixed IP for the plotter (`plotter_ip`), your router's IP (`gateway_ip`), and passwords. Generate the API key with `openssl rand -base64 32`.

   If you'd rather use a DHCP reservation on your router, delete the `manual_ip:` block from the YAML.
3. **Check the config** (the external component is downloaded on first run):
   ```bash
   esphome config xy-plotter-bridge.yaml
   ```
4. **First flash, over USB:**
   ```bash
   esphome run xy-plotter-bridge.yaml
   ```
   Pick the serial port when asked. Later updates can go over WiFi (OTA) with the same command.
5. **Watch the logs** to confirm WiFi is connected and the stream server is listening:
   ```bash
   esphome logs xy-plotter-bridge.yaml
   ```

In VS Code, the same steps are available as tasks: *Terminal → Run Task → "ESPHome: validate config" / "ESPHome: flash over USB / OTA" / "ESPHome: show logs"*.

What the config does:

| Setting | Why |
| --- | --- |
| `stream_server.port: 1234` | The TCP port the web UI connects to. Change `bridge_port` and the UI's Port field together. |
| `uart.baud_rate: 115200` | GRBL 1.1's default baud rate. |
| `logger` | Logs go to USB (UART0) and over WiFi. GRBL is on UART2 (GPIO16/17), so log text never ends up in the plotter's data stream. |
| `api.reboot_timeout: 0s` | Home Assistant is optional. Without this, ESPHome reboots the ESP after 15 minutes with no API client, cutting off long plots. |
| `wifi.power_save_mode: none` | Avoids latency spikes and dropped connections during long plots. |
| `binary_sensor: stream_server` | Shows in ESPHome / Home Assistant whether the web UI is connected. |
| `external_components` | The stream server is pinned to a fixed commit, so an upstream change can't break a later build. Update the hash deliberately. |
| `status_led: GPIO2` | The on-board LED blinks while WiFi or the API is not connected. |
| `button: restart / safe_mode` | Restart the ESP from the ESPHome dashboard or Home Assistant without power-cycling it. |

> **Security:** the TCP port has no authentication. Anyone on the same network can send G-code and move the machine. Keep the plotter on a trusted network (or its own VLAN), and don't forward the port to the internet.

## 5. Test the bridge

From any computer on the same network:

```bash
nc 192.168.100.228 1234      # or: telnet 192.168.100.228 1234
```

Type `$I` and press Enter. GRBL should answer with its version and `ok`. Press `Ctrl-C` to quit.

Then start the web UI (`npm start`), enter the ESP's IP and port `1234`, and click **Connect**. Send `$$` from the console to see GRBL's settings.

Recommended UI settings for stock GRBL 1.1 (⚙ Settings):

- **Jog method:** `$J=` jog command. GRBL 1.1 supports it, and it never changes the modal state.
- **Status polling:** every 250–500 ms. GRBL supports `?`, and this gives live position and machine state.
- **Streaming:** *Fast* with a receive buffer of `128` (GRBL on an Uno/Nano). This keeps GRBL's planner fed despite WiFi latency, so curves made of many short segments plot smoothly instead of stuttering. If you rebuilt GRBL with a different `RX_BUFFER_SIZE`, enter that value instead.
- **Invert X/Y:** set so the jog buttons move the pen in the direction shown.

## 6. Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| *Could not connect … ECONNREFUSED* | Wrong IP/port, or the ESP isn't running the bridge config. Check `esphome logs`. |
| *Could not connect … timed out* | ESP not on the network. Check WiFi credentials, signal, and the fixed IP or DHCP reservation. |
| *… is not a local network address* | The server only connects to LAN addresses by default. Set `ALLOWED_TARGETS` in `.env`. |
| Connects, but commands get no reply and time out | TX/RX swapped, no common ground, Uno USB still plugged in, or a baud rate mismatch. |
| Garbled characters in the console | Baud rate mismatch between `uart.baud_rate` and GRBL. |
| `error:9` / `ALARM:…` | GRBL is locked (often after a reset during motion). Click **Unlock** (`$X`), check the position, then continue. |
| Plotting stutters or pauses between short segments | The sender can't keep up over WiFi. Switch Streaming to *Fast*. |
| Random `error:1`/`error:2` only in Fast mode | The receive buffer setting is larger than the firmware's real buffer, so data is being dropped. Set it to `128`, or use *Safe*. |
| Connection drops mid-plot | Weak WiFi or power brown-outs. Keep **Auto-reconnect** and **Auto-resume** on, and the job continues from where it stopped. |
| Job pauses with "Controller reset" | GRBL rebooted (power dip, reset button). The position may be lost: re-home or re-zero, then resume or restart. |
| Axis moves the wrong way | Fix the hardware with GRBL `$3`, or only the jog buttons with Invert X/Y in the UI. |

> **Security:** the TCP bridge has no authentication. Anyone on the network who can reach port 1234 can move the plotter. Keep it on a trusted network.

## Alternative: GRBL on the ESP32 itself

If you'd rather drop the Arduino, firmwares like **FluidNC** run the motion control directly on an ESP32 and accept GRBL-style commands over WiFi through a telnet port. The web UI works with them unchanged: connect to the ESP's IP and the firmware's telnet port (check its docs, commonly `23`). Skip sections 3–4 of this guide and follow the firmware's own setup instructions.
