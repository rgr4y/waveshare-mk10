# MK10 Studio validation checklist

Manual pass over the Electron app (`app/`). Tick each box, and note failures inline with what you saw.
Items marked **[done 2026-11-24]** were already exercised during the build, mostly through MCP. Re-check them only if something nearby changed.

## 0. Setup

- [ ] Quit ScreenKeyMacOS. It holds the serial port.
- [ ] `cd app && npm install && npm start`. The window opens and the log panel shows no errors.
- [ ] `ffmpeg -version` works. It is needed for image and video replacement.
- [ ] MK10 is plugged in over USB. `ls /dev/cu.usbmodemMK10*` lists the port.
- [ ] Baseline: the device shows the stock layout, and the video is playing.
- [ ] Optional backup before pushing: `scp root@10.0.1.48:/mnt/SDCARD/config.json /tmp/config.json.bak`

## 1. Open

- [ ] First run, with no last file: the empty state shows **Open stock defaultTheme**. Clicking it opens the stock theme.
- [ ] **Open…** starts in the stock ScreenKey theme dir. Pick `defaultTheme.Theme`.
- [ ] The page list shows every page. Child pages are nested under their parent, and the current page has a marker.
- [ ] The preview shows the background video, key icons and titles, and the secondary panel widgets, roughly as the device does.
- [ ] Click through every page. Nothing errors, and pages without a video show the "no video" placeholder.
- [ ] Quit and relaunch. The last file reopens automatically.
- [ ] Open a non-theme file, for example a `.png` renamed to `.Theme`. A clear error appears in the status line or log, and the app keeps working.

## 2. Inspect

- [ ] Click a key. The key gets a blue ring and tint, and the inspector shows position (page/row/col), thumbnail, title and action.
- [ ] **Show gaps between keys** (Settings) is on by default and draws a dark bezel between keys, empty slots included. Toggle it off, then relaunch: it stays off.
- [ ] Check the action read-out on several keys: hotkey, page switch, URL/app. It looks sane, with no `undecodable`.
- [ ] Click the video area. The inspector shows video info.
- [ ] `Esc` (outside a text box) clears the selection.

## 2b. Edit: action values

- [ ] An openWeb key (page 12, row 0 col 1) shows `Url` and `description` as text boxes. `type` stays plain text.
- [ ] Change the Url and press Enter. The dirty dot appears. Reselecting the key shows the new value.
- [ ] Hotkey keys: `keyString` is not editable (it is paired with the int `keycode`).
- [ ] openPage `pageName` set to a name that doesn't exist: you get the error "no page named …", and the theme is unchanged.
- [ ] MCP `set_key_action_field` makes the same edits. `get_page` lists the editable fields under `action.editable`.
- [ ] Device: change an openPage key's `pageName` to another child page, then push. Pressing the key opens that page.
- [ ] Device and ScreenKey host: an edited openWeb Url opens the new URL. This needs a host app that runs actions, either vendor ScreenKey after the push or our Phase 3.

## 3. Edit: title

- [ ] Change a key title in the inspector and press Enter or tab out. The preview updates, and the dirty dot appears.
- [ ] Multi-line title, if supported by the key's titleParam: layout looks right.
- [ ] Empty title: allowed, and the key shows no text.
- [ ] Unicode and emoji title: preview renders. Check on the device after pushing (section 6).

## 4. Edit: key image

- [ ] **Replace image…** with a PNG. The key and thumbnail update.
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

## 6. Save

- [ ] **Save** while the stock theme from the `.app` bundle is open: it goes to **Save As** instead. The bundle file is untouched; compare its sha256 before and after.
- [ ] Save As to `~/Desktop/test.Theme`. The dirty dot clears.
- [ ] Reopen `test.Theme`. All edits from sections 3–5 survived.
- [ ] Unedited round trip: open `img/stock/defaultTheme.Theme`, Save As, then `shasum -a 256`. The output equals `88785d8b…` (SHA256SUMS.txt). The unit test covers this; spot-check it.
- Note: the bundle `defaultTheme.Theme` was overwritten by an accidental ScreenKey save on 2026-11-24 (69 keys, sha `b5b75da0…`). The pristine copy is `img/stock/defaultTheme.Theme` (read-only, untracked, sha in SHA256SUMS.txt).
- [ ] Quit (Cmd+Q) with unsaved edits. You get the "Unsaved changes" prompt. Cancel keeps the app; Discard quits. (Closing the window only hides it, see 7b.)
- [ ] Cmd+O, Cmd+S and Cmd+Shift+S work.

## 7. Push (USB serial)

- [ ] **Push to device** shows a confirm dialog. Cancel does nothing.
- [ ] Push. The log shows progress in 10% steps, then `reload …`, `removed old pushes …` (on the second push and later), then `pushed`. About 10 s for 12 MB.
- [ ] The device shows the edits: titles, images, video. Press keys: hotkeys still work.
- [ ] Push again. Only one `mk10studio-*.Theme` remains:
      `ssh root@10.0.1.48 'ls -la /data/theme/MK10/*.Theme'`
- [ ] Pull the USB cable mid-push. You get a clean error, the device keeps showing the previous theme, and a re-push after replugging works.
- [ ] Push with ScreenKeyMacOS running, so the port is busy. You get a clear error, not a hang.
- [ ] Push with no device plugged in. The error is "MK10 serial port not found".
- [ ] Unicode and emoji titles from section 3 render on the device.
- [ ] Device reboot after a push. The pushed theme is still the active one.

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

- [ ] **Device: …** (top right) opens the device popover; click outside or press Esc to close. The button shows the push mode.
- [ ] Switch the push mode to ssh. Host and remote fields persist across restart.
- [ ] Push. The device restarts keyboard-device with about 10 s blank, then shows the edits, background video included. If the video player did not start, the log shows a warning (seen once, not reproduced).
- [ ] Wrong host gives a clean error within about 5 s (ConnectTimeout).

## 9. MCP

- [ ] **Settings** button and Cmd+, both open Settings. Esc and **Done** close it.
- [ ] Toggle MCP on in Settings. The `claude mcp add …` command appears and **Copy command** copies it. The green **MCP** badge shows in the top bar, and clicking it opens Settings. The setting persists across restart.
- [ ] Turn off **Reopen last theme on launch** and relaunch: the app starts empty. Turn it back on.
- [ ] `claude mcp add --transport http mk10 http://127.0.0.1:47110/mcp`, then in Claude: "show the theme pages". `get_theme` and `get_page` return sane data.
- [ ] "Set key row 0 col 1 title to Hello". The UI updates live and the dirty dot appears. **[done 2026-11-24]**
- [ ] "Set that key's image to <path>" and "use this video as background". The UI updates live. **[done 2026-11-24]**
- [ ] `get_asset` returns a key image that Claude can see.
- [ ] `save_theme` on the stock bundle theme without a path returns an error, and the file is untouched.
- [ ] `push_to_device` pushes using the push mode from the UI. **[done 2026-11-24]**
- [ ] Change the port to something else and toggle off then on. It listens on the new port.
- [ ] Port in use (`nc -l 47110` first): you get a clean error, and the toggle does not get stuck on.
- [ ] Host header guard: `curl -H 'Host: evil.com' http://127.0.0.1:47110/mcp` is rejected.
- [ ] Toggle off. The port closes (`ports | grep 47110` is empty).

## 10. Restore the device

- [ ] Open the stock `defaultTheme.Theme` and push it. Or restore `config.json` from the backup and run `rc-service keyboard-device restart`.
- [ ] Remove the test pushes:
      `ssh root@10.0.1.48 'rm -f /data/theme/MK10/mk10studio-*.Theme'`
- [ ] Known leak: each push extracts its new images and videos under `/data/image/MK10/cache/` and `/data/theme/MK10/MainScreen/`, and these are not cleaned up. List them and delete the ones the stock theme doesn't use. The stock videos are `2e37fe8c-….mp4` and `40624559-….mp4`.

## Not in scope yet (don't fail these)

- Action **values** are editable (existing text fields only). Changing the action type or adding actions, and running host actions (URL or app on press), is Phase 3.
- Widget editing and the live stats feed are Phase 4. The stats feed protocol is verified; the app doesn't send it yet.
- Adding or removing pages and keys.
- Animated GIF keys are replaced with a static image.
