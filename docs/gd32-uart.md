# GD32 key UART (`/dev/ttyS1`)

KeyboardDevice talks to the GD32 key MCU over `/dev/ttyS1` (115200, raw). Captured 2026-11-25 with the LilAlpine `mk10-gd32-relay` service (perl relay + pty bind-mounted over `/dev/ttyS1`, log in `/run/mk10-gd32/log`).

## Frame

13 bytes:

```
aa 55 <sum> 06 f9 <cmd> <a> <row> <col> 00 00 f5 5f
```

- `sum` = (bytes 3..10 added + 1) & 0xff. Checked against every captured frame.
- `row` 0..1 (0 = top), `col` 0..4 (0 = left). Same numbering as V1 `keyState` and V2 `keyStateChanged`.

| cmd | Direction | Meaning |
|---|---|---|
| `0x16` | GD32 to daemon | key event, `a` = 1 press, 0 release |
| `0x05` | daemon to GD32, GD32 echoes it back | sent for every key (row 0 then row 1, cols 0..4) after a page change; `a` was always 0. Probably `request_upload_key(row, col)`: ask the GD32 to report that key's state (see below). The echo's `a` is presumably the key's current state; not checked with a key held during a page change |

Two key events can arrive in one read (two keys held together). The daemon also sent one 4-byte write `02 aa e2 78` after a page change; not decoded.

The GD32 side of KeyboardDevice is the class `STM32CommunicationObject`, from the symbol names in `/data/KeyboardDevice` (`strings`, no disassembly). Its only members are `readyRead`, `on_timeout`, `keyStateChanged(uchar ×5)` and `request_upload_key(uchar, ushort)`. The five bytes match `<a> <row> <col> 00 00`. So this link only carries key state. Typing, macros and mouse actions (`qmk_string`, `qmk_mouse`) don't go over it.

## Injecting presses

With the relay running, `mk10-gd32-inject key <row> <col> [tap|press|release]` writes a key frame to KeyboardDevice as if the GD32 sent it. Raw hex works too: `mk10-gd32-inject aa551c06f9160101040000f55f`.

Verified 2026-11-25: injecting row 1 col 4 (a `pageSwitch` key) woke the screen, switched page, and the host (lenny, `/dev/ttyACM0`) got the V1 cmd 15 page contract plus V1 cmd 13 `keyState` press and release frames, the same as a real press. So Studio's key-action path can be driven without touching the device.

Start and stop of the service each restart keyboard-device (screen blank for about 10 s). If the relay dies, keys stop until `rc-service mk10-gd32-relay stop`. Stop lazy-unmounts the pty (`umount -l`); a plain umount failed with EBUSY and left KeyboardDevice on the dead pty, so keys stayed dead after a stop (fixed 2026-11-25).

## Studio key path, checked with injected presses (2026-11-25)

On lenny (Node 20; `/tmp/mk10-studio` holds a copy of `app/`), a script doing what `main.js` `onKeyEvent` does (now `node cli.js keys 30`) printed the plan for every injected press:

- The 9 openWeb keys of the Websites folder planned `{run: 'url', …}` with the right URL on press, `null` on release.
- Replay guard: two taps injected while no host had the port open arrived as a burst when it opened. The openWeb press in the burst planned `{drop: true}`.
- The release frame carries the action of whatever key is at that position after the press ran. A page or folder key's release reports the new page's key (for example `r0c0 down openPage`, then `r0c0 up openWeb`). The planner acts on press only, so this does not matter to it.
- A pageSwitch tap gave no release frame when the new page has no key at that position (seen once; not checked further).

Not covered: the Electron glue in `main.js` (`shell.openExternal` / `openPath`, toasts, Activity log). That still needs Rob's checks in docs/mk10-studio-validation.md.
