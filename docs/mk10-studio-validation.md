# MK10 Studio validation checklist

Manual pass over the Electron app (`app/`). Tick each box, and note failures inline with what you saw.
Items marked **[done 2026-11-24]** were already exercised during the build, mostly through MCP. Re-check them only if something nearby changed.

## 0. Setup

- [x] Quit ScreenKeyMacOS. It holds the serial port.
- [x] `cd app && npm install && npm start`. The window opens and the log panel shows no errors.
- [x] `ffmpeg -version` works. It is needed for image and video replacement.
- [x] MK10 is plugged in over USB. `ls /dev/cu.usbmodemMK10*` lists the port.
- [x] Baseline: the device shows the stock layout, and the video is playing.
- [ ] Optional backup before pushing: `scp root@10.0.1.48:/mnt/SDCARD/config.json /tmp/config.json.bak`

## 1. Open

- [ ] First run, with no last file: the empty state shows **Open stock defaultTheme**. Clicking it opens the stock theme.
- [x] **Open…** starts in the stock ScreenKey theme dir. Pick `defaultTheme.Theme`.
- [x] The page list shows every page. Child pages are nested under their parent, and the current page has a marker.
- [x] The preview shows the background video, key icons and titles, and the secondary panel widgets, roughly as the device does.
- [x] Click through every page. Nothing errors, and pages without a video show the "no video" placeholder.
- [x] Quit and relaunch. The last file reopens automatically.
- [ ] Open a non-theme file, for example a `.png` renamed to `.Theme`. A clear error appears in the status line or log, and the app keeps working.

## 2. Inspect

- [x] Click a key. The key gets a blue ring and tint, and the inspector shows position (page/row/col), thumbnail, title and action.
- [ ] **Show gaps between keys** (Settings) is on by default and draws a dark bezel between keys, empty slots included. Toggle it off, then relaunch: it stays off.
- [x] Check the action read-out on several keys: hotkey, page switch, URL/app. It looks sane, with no `undecodable`.
- [x] Click the video area. The inspector shows video info.
- [ ] `Esc` (outside a text box) clears the selection.

## 2b. Edit: action values

- [x] An openWeb key (page 12, row 0 col 1) shows `Url` and `description` as text boxes. `type` stays plain text.
- [x] Change the Url and press Enter. The dirty dot appears. Reselecting the key shows the new value.
- [ ] Hotkey keys: `keyString` is not editable (it is paired with the int `keycode`).
- [ ] openPage `pageName` set to a name that doesn't exist: you get the error "no page named …", and the theme is unchanged.
- [ ] MCP `set_key_action_field` makes the same edits. `get_page` lists the editable fields under `action.editable`.
- [x] Device: change an openPage key's `pageName` to another child page, then push. Pressing the key opens that page.
- [ ] Device and ScreenKey host: an edited openWeb Url opens the new URL. This needs a host app that runs actions, either vendor ScreenKey after the push or our Phase 3.

## 3. Edit: title

- [x] Change a key title in the inspector and press Enter or tab out. The preview updates, and the dirty dot appears.
- [ ] Multi-line title, if supported by the key's titleParam: layout looks right.
- [ ] Empty title: allowed, and the key shows no text.
- [ ] Unicode and emoji title: preview renders. Check on the device after pushing (section 6).

## 4. Edit: key image

- [x] **Replace image…** with a PNG. The key and thumbnail update.
- [ ] JPEG, non-square, and large (4000px) images: cover-cropped to 128x128 with no distortion.
- [ ] Drag-drop an image onto a key. The key shows a dashed outline on hover, and the image is replaced on drop.
- [ ] Replace the **GIF key** (animated). It becomes the static first frame. Expected for now.
- [ ] Drop a non-image file (`.txt`) on a key. You get a clean error, and the theme is unchanged.
- [ ] Drop a file on empty window space. The window does not navigate away.

## 5. Edit: background video

- [ ] **Replace video…** with an `.mov` or `.mp4` of any size. The status shows "Transcoding…", then the preview plays the new video.
- [ ] Drag-drop a video onto the video area. Same result.
- [ ] Odd aspect ratio (portrait phone video): cover-cropped to 640x256, not stretched.
- [ ] Long clip (1 min or more): transcode finishes, and note the time and output size. The theme size grows by roughly that amount.
- [ ] Clip with audio: the audio is dropped and the clip still plays.
- [ ] Animated GIF as video: works or fails cleanly.

## 5b. Key clipboard

- [x] Right-click a key: Cut, Copy, Paste, Delete Key. On an empty slot only Paste is enabled, and only after a key was copied.
- [x] Clock page / GIF folder: cells with widgets but no key show the widget; the Inspector names it; Paste there fails with "holds a widget".
- [x] Right-click > Press Key on a folder key opens the folder, on oneLevelUp returns to the parent, on a pageSwitch key goes to the page the device goes to (jumpToPage numbering confirmed on the device 2026-11-25).
- [x] Copy a key, click an empty slot, Cmd+V: the key appears there with its image and title. The status says "Paste key r… c…: done".
- [ ] Cut a GIF key, paste it on another page: it still animates (frames come along).
- [ ] Delete or Backspace on a selected key empties the slot. Cmd+Z brings it back. Cmd+Z after a title edit says "nothing to undo".
- [ ] Cmd+C / Cmd+V inside the key title box and the MCP command box copy text, not keys.
- [ ] Copy a key, open another theme, paste: it works there too. Pasting an openPage key into a theme without its folder logs a warning.
- [ ] Copy a key, paste it into a text editor: readable JSON starting `{"mk10studio":"key","v":1`.
- [ ] Push a theme with a pasted key: it shows and works on the device.

## 6. Save

- [ ] **Save** while the stock theme from the `.app` bundle is open: it goes to **Save As** instead. The bundle file is untouched; compare its sha256 before and after.
- [ ] Save As to `~/Desktop/test.Theme`. The dirty dot clears.
- [ ] Reopen `test.Theme`. All edits from sections 3–5 survived.
- [ ] Unedited round trip: open `img/stock/defaultTheme.Theme`, Save As, then `shasum -a 256`. The output equals `88785d8b…` (SHA256SUMS.txt). The unit test covers this; spot-check it.
- Note: the bundle `defaultTheme.Theme` was overwritten by an accidental ScreenKey save on 2026-11-24 (69 keys, sha `b5b75da0…`). The pristine copy is `img/stock/defaultTheme.Theme` (read-only, untracked, sha in SHA256SUMS.txt).
- [x] Quit (Cmd+Q) with unsaved edits. You get the "Unsaved changes" prompt. Cancel keeps the app; Discard quits. (Closing the window only hides it, see 7b.)
- [ ] Cmd+O, Cmd+S and Cmd+Shift+S work.

## 7. Push (USB serial)

- [ ] **Push to device** shows a confirm dialog. Cancel does nothing.
- [x] Push. The log shows progress in 10% steps, then `reload …`, `removed old pushes …` (on the second push and later), then `pushed`. About 10 s for 12 MB.
- [ ] The device shows the edits: titles, images, video. Press keys: hotkeys still work.
- [ ] Push again. Only one `mk10studio-*.Theme` remains:
      `ssh root@10.0.1.48 'ls -la /data/theme/MK10/*.Theme'`
- [ ] Pull the USB cable mid-push. You get a clean error, the device keeps showing the previous theme, and a re-push after replugging works.
- [ ] Push with ScreenKeyMacOS running, so the port is busy. You get a clear error, not a hang.
- [ ] Push with no device plugged in. The error is "MK10 serial port not found".
- [ ] Unicode and emoji titles from section 3 render on the device.
- [x] Device reboot after a push. The pushed theme is still the active one.

## 7b. Resident app

- [ ] Fresh settings (remove `settings.json` from the userData dir, or delete `onboarded`): the welcome dialog shows once, MCP and Start at login both ticked. Press Get started. MCP is listening; the login item exists.
- [ ] Close the window (red button) with MCP on. The window hides, the Dock icon goes, the "MK10" tray item stays. `curl -s http://127.0.0.1:47110/mcp` still answers (or Claude's `get_theme` still works).
- [ ] Tray > Open MK10 Studio brings the window and Dock icon back with the theme and unsaved edits intact.
- [ ] Launch a second copy (`open -n` or `npm start` again). No new window or tray item appears; the running window focuses.
- [ ] Edit something, then Cmd+Q. The window shows with "Unsaved changes". Cancel keeps the app running; Discard changes quits. Same from tray > Quit MK10 Studio. With no edits, quit is immediate.
- [ ] Tray > Push to device is greyed out with no theme open. With a theme open it pushes (same result as the button), with the window hidden.
- [ ] Tray > MCP server checkbox starts and stops MCP; it matches the Settings toggle.
- [ ] Settings > General > Start at login: tick it and check System Settings > General > Login Items lists MK10 Studio. Untick it and the entry goes.
- [ ] With Start at login on, log out and in (or reboot). The app comes up menu-bar only: tray item, no window, no Dock icon. `npm start -- --hidden` does the same.
- [ ] Settings > Permissions: Accessibility and Screen Recording show their status. Opening Settings shows no system prompt. Each Open button lands on the right System Settings pane (Accessibility, Screen Recording, Automation). Granting one in System Settings shows up in the status within a couple of seconds, while the dialog is open.

## 8. Push (ssh mode, LilAlpine only)

- [x] **Device: …** (top right) opens the device popover; click outside or press Esc to close. The button shows the push mode.
- [x] Switch the push mode to ssh. Host and remote fields persist across restart.
- [x] Push mode Auto: on LilAlpine the Activity log says `auto: LilAlpine detected` and the push goes over ssh; on stock firmware it says `stock firmware detected` and uses USB serial; with the device unplugged and off the network, the push fails with `no MK10 found`.
- [x] Push. The device restarts keyboard-device with about 10 s blank, then shows the edits, background video included. If the video player did not start, the log shows a warning (seen once, not reproduced).
- [ ] Wrong host gives a clean error within about 5 s (ConnectTimeout).

## 9. MCP

- [x] **Settings** button and Cmd+, both open Settings. Esc and **Done** close it.
- [ ] Toggle MCP on in Settings. The `claude mcp add …` command appears and **Copy command** copies it. The green **MCP** badge shows in the top bar, and clicking it opens Settings. The setting persists across restart.
- [ ] Turn off **Reopen last theme on launch** and relaunch: the app starts empty. Turn it back on.
- [x] `claude mcp add --transport http mk10 http://127.0.0.1:47110/mcp`, then in Claude: "show the theme pages". `get_theme` and `get_page` return sane data.
- [x] "Set key row 0 col 1 title to Hello". The UI updates live and the dirty dot appears. **[done 2026-11-24]**
- [x] "Set that key's image to <path>" and "use this video as background". The UI updates live. **[done 2026-11-24]**
- [ ] `get_asset` returns a key image that Claude can see.
- [ ] `save_theme` on the stock bundle theme without a path returns an error, and the file is untouched.
- [x] `push_to_device` pushes using the push mode from the UI. **[done 2026-11-24]**
- [ ] Change the port to something else and toggle off then on. It listens on the new port.
- [ ] Port in use (`nc -l 47110` first): you get a clean error, and the toggle does not get stuck on.
- [ ] Host header guard: `curl -H 'Host: evil.com' http://127.0.0.1:47110/mcp` is rejected.
- [ ] Toggle off. The port closes (`ports | grep 47110` is empty).

## 10. Restore the device

- [ ] Open the stock `defaultTheme.Theme` and push it. Or restore `config.json` from the backup and run `rc-service keyboard-device restart`.
- [x] Remove the test pushes:
      `ssh root@10.0.1.48 'rm -f /data/theme/MK10/mk10studio-*.Theme'`
- [x] Known leak: each push extracts its new images and videos under `/data/image/MK10/cache/` and `/data/theme/MK10/MainScreen/`, and these are not cleaned up. List them and delete the ones the stock theme doesn't use. The stock videos are `2e37fe8c-….mp4` and `40624559-….mp4`.

## Not in scope yet (don't fail these)

- Action **values** are editable (existing text fields only). Changing the action type or adding actions, and running host actions (URL or app on press), is Phase 3.
- Widget editing and the live stats feed are Phase 4. The stats feed protocol is verified; the app doesn't send it yet.
- Adding or removing pages. Keys can be added and removed only through the key clipboard (5b).
- Animated GIF keys are replaced with a static image.

### Checked on the device (LilAlpine, ssh), 2026-11-25
- [x] pageSwitch jumpToPage 3 from Page 0 lands on Studio's "Page 3" (top-level numbering).
- [x] Raw JSON edit of an int action field, Apply, push: the device follows it and loads the theme.
- [x] openPage pointed at a folder under another page: opens it, and back works.
- [x] Push, Pull and Device settings stay disabled for a whole push.
- [x] Auto mode on LilAlpine logs the detection and pushes over ssh.

### Checked in the app, 2026-11-25
- [x] Cut a key, right-click an empty slot: Paste is enabled and restores it; Cmd+Z undoes.
- [x] Paste onto a widget cell (clock digits, GIF folder images) is refused. Paste onto a key (e.g. Page 0's GIF folder key) replaces it, by design.
- [x] Right-click > Press Key: folder, back, pageSwitch and the toggle key's state preview.
- [x] Quit with unpushed edits: Push to Device…, Discard and Cancel each work.
- [x] Device fonts: deleting the cache and pulling copies them back; the Settings button re-copies.
- [x] Capture keys (Settings): the QMK column fills for normal keys and F-keys.

### Checked on the device (LilAlpine, ssh), 2026-11-25, sound and levels
- [x] Sound keys play, overlap each other (dmix), and type nothing.
- [x] Soundboard: Next, First (last page) and Home keys.
- [x] Brightness and Volume sliders change the device.
- [x] Inspector Sound > Choose…, then push: the key plays the new sound.
- [x] Monaco raw JSON modal: Apply changes the key.
- [x] Watchdog-only reset: `watchdog -T 5 -t 600 /dev/watchdog` (never fed). Down after 5 s, ping back after 26 s, fresh boot (`uptime` 0 min).
- [x] Settings > Developer > **JSON RPC window…** button opens the window (Rob).
- [x] With the window open, Studio holds the port and device events stream: JSON `keyStateChanged` plus decoded V1 cmd 13 key events (with the key's action) and cmd 15 page contracts (Rob's presses on the soundboard and stock keys).

### Still to check
- [x] `reboot` with `mk10-reboot-wdt` installed: back in about 15 s, and `/var/log/mk10-reboot-wdt.log` shows `armed /dev/watchdog 10s` (Rob, 2026-11-25). `poweroff` also ends in a reset (expected, untested).
- [ ] Settings > Developer > JSON RPC window: move the Volume slider. A `setVolume` → and its ack ← appear. A serial push shows `saveToFile` with shortened `data`. Closing the window releases the port.
