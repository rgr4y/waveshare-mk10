# Handoff: mainline atmel-sha204a as modules, tested as hwrng on the MK10

Date: 2026-11-24. Written for an agent starting cold.

## Goal

1. Build the mainline ATSHA204A driver from the 5.4 tree as loadable modules for the vendor kernel.
2. Block the vendor driver temporarily (runtime unbind only; nothing persists).
3. Load the mainline modules and prove the chip works as a hwrng.

Out of scope: flashing a kernel, editing the u-boot env, reconstructing the vendor `atsha204a` driver, and the MAC/nonce/key features (mainline doesn't expose them).

## Facts (verified 2026-11-24)

### Vendor kernel on the device
- 5.4.61, built with Linaro GCC 6.4.
- vermagic is `5.4.61 SMP preempt mod_unload ARMv7 p2v8 ` (note the trailing space).
- `CONFIG_MODVERSIONS` and `CONFIG_MODULE_SIG` are both unset. Only vermagic has to match.

### Vendor config
- The vendor `.config` was extracted from the vmlinux IKCFG blob. On chonk it is at `~/build/mk10/mk10.config`.
- Relevant symbols:
  - `CONFIG_CRYPTO_DEV_ATSHA204A=y` is the vendor's own driver. It isn't in the tree.
  - `# CONFIG_CRYPTO_DEV_ATMEL_SHA204A is not set`
  - `# CONFIG_HW_RANDOM is not set`, so the hwrng core is **not** in the kernel.
  - `CONFIG_CRC16=y`, `CONFIG_I2C=y`.
- `add_hwgenerator_randomness` is exported from `drivers/char/random.c` and its string is in the vendor vmlinux.

### Modules needed, in load order
1. `rng-core.ko`: `drivers/char/hw_random/core.c` (`CONFIG_HW_RANDOM=m`).
2. `atmel-i2c.ko`: `drivers/crypto/atmel-i2c.c` (`CONFIG_CRYPTO_DEV_ATMEL_I2C`, selected).
3. `atmel-sha204a.ko`: `drivers/crypto/atmel-sha204a.c` (`CONFIG_CRYPTO_DEV_ATMEL_SHA204A=m`).

There's no depmod or modules.dep for these, so use `insmod` in this order.

### The tree's 5.4 driver
- RNG only, with `hwrng.quality = 1024`, so it credits entropy.
- i2c driver name is `atmel-sha204a`; compatible is `atmel,atsha204a`.
- Mainline master adds a read-only sysfs `otp` attribute. Optional backport, not required here.

### The device
- Reached at `ssh root@10.0.1.48`; key-only, Alpine userland (LilAlpine).
- The chip is at `i2c-2`, address `0x64`, device `2-0064`.
- The vendor driver is bound as `/sys/bus/i2c/drivers/atsha204a`. It creates `/dev/atsha204a` (char device, major 243).
- There's no `/sys/class/misc/hw_random` today.
- The vendor app `/data/KeyboardDevice` (service `keyboard-device`) does `--atsha204a-- Key(11) verify OK` about 1 s after every start.
  - With the chip unbound, the app still started and logged nothing about the chip.
  - Rob still has to confirm that app instance behaved normally.
- **Restarting `keyboard-device` drops Wi-Fi for a few seconds**: the app relaunches `wpa_supplicant` and `udhcpc`. Run anything spanning a restart detached (`nohup`) and write its output to a file.
- `bind`/`unbind` writes sometimes print `write error: No such device` even when they worked. Trust `readlink /sys/bus/i2c/devices/2-0064/driver` and `dmesg`, not the echo exit code.

### Build host: chonk
- Debian 13, 32 cores.
- Tree: `~/build/mk10/kernel`.
  - Clone of `rgr4y/tina-t113-linux-5.4-new` (Rob's fork), shallow.
  - HEAD is `50e671d` (the fb_gc9107 driver). Don't commit anything else there for this task.
- Toolchain: `T=$HOME/build/mk10/armv7-eabihf--glibc--stable-2018.11-1/bin/arm-linux-` (Bootlin, gcc 7.3).
  - Pass it as `CROSS_COMPILE=$T`.
  - Do **not** put it on `PATH`: its bundled bison breaks kconfig.
- **Always pass `LOCALVERSION=`** (empty). Without it, `setlocalversion` appends `+` and the vermagic becomes `5.4.61+`, which the device rejects.
- Prior art: `~/build/mk10/modtest/` built `fb_gc9107t.ko` out of tree the same way.
- Do NOT build on the Mac. The local `./kernel` checkout is damaged by case-insensitivity (the `xt_*.h` collisions).

## Do

### 1. Build (chonk)
```sh
cd ~/build/mk10/kernel
T=$HOME/build/mk10/armv7-eabihf--glibc--stable-2018.11-1/bin/arm-linux-
cp .config .config.gc9107.bak
scripts/config --file .config -m HW_RANDOM -m CRYPTO_DEV_ATMEL_SHA204A
make ARCH=arm CROSS_COMPILE=$T LOCALVERSION= olddefconfig
grep -E 'CONFIG_(HW_RANDOM|CRYPTO_DEV_ATMEL_I2C|CRYPTO_DEV_ATMEL_SHA204A)=' .config   # expect =m for all three
make -j32 ARCH=arm CROSS_COMPILE=$T LOCALVERSION= KBUILD_MODPOST_WARN=1 W=1 \
  drivers/char/hw_random/rng-core.ko drivers/crypto/atmel-i2c.ko drivers/crypto/atmel-sha204a.ko
```
- If single `.ko` targets don't work in this 5.4 tree, run `make … modules_prepare`. Then build the two directories with `M=`-style targets, or use `make … modules` and pick out the three files.
- Check each module with `strings X.ko | grep -E '^(vermagic|depends|name)='`. The vermagic must equal the vendor string exactly.
- Check the undefined symbols with `${T}nm -u X.ko`. Every symbol must come from the kernel or from an earlier module in the load order.
- **Rule out `HW_RANDOM_*` platform drivers.** Setting `HW_RANDOM=m` can enable some by default. Only `rng-core.ko` should be copied.
- Copy the three `.ko` files to the device's `/tmp/`. Record their sha256s.

### 2. Temporary block (device)
```sh
dmesg -c > /dev/null
echo 2-0064 > /sys/bus/i2c/drivers/atsha204a/unbind
readlink /sys/bus/i2c/devices/2-0064/driver   # expect nothing
ls /dev/atsha204a                             # expect: No such file
```
- No reboot, no env change, no rootfs change. A reboot restores the vendor driver.
- Don't restart `keyboard-device` for this test. The running app doesn't hold `/dev/atsha204a` open.

### 3. Load and test (device)
```sh
insmod /tmp/rng-core.ko && insmod /tmp/atmel-i2c.ko && insmod /tmp/atmel-sha204a.ko
dmesg | tail -20
readlink /sys/bus/i2c/devices/2-0064/driver          # expect .../atmel-sha204a
cat /sys/class/misc/hw_random/rng_available /sys/class/misc/hw_random/rng_current   # expect 2-0064
dd if=/dev/hwrng bs=32 count=8 2>/dev/null | od -An -tx1
time dd if=/dev/hwrng of=/dev/null bs=32 count=64
cat /proc/sys/kernel/random/entropy_avail
```
Pass criteria:
- The output isn't constant or repeating.
- In particular, it isn't the `ff ff 00 00` pattern the chip returns when its config zone is unlocked. That pattern is from memory of the datasheet; check it against the ATSHA204A datasheet before treating it as a fail signal.
- Two reads differ.
- No errors in dmesg.
- Record the throughput: tens of ms per 32 bytes is expected over I2C.
- Optional: if `rngtest` (rng-tools) is installed, run `dd if=/dev/hwrng bs=2500 count=8 | rngtest`. Don't install packages without asking Rob.

### 4. Restore (device)
```sh
rmmod atmel_sha204a atmel_i2c rng_core
echo 2-0064 > /sys/bus/i2c/drivers/atsha204a/bind
readlink /sys/bus/i2c/devices/2-0064/driver   # expect .../atsha204a
ls -l /dev/atsha204a
```
Then ask Rob before restarting `keyboard-device`. A restart gets a verified app instance, but costs a short Wi-Fi drop.

## Report back
- The sha256 and vermagic of each `.ko`.
- dmesg from the load.
- The hwrng sample, the throughput and `entropy_avail`.
- Whether the restore worked.

## Rules
- Device writes are limited to: `/tmp/*.ko`, the i2c `bind`/`unbind` for `2-0064`, `insmod`/`rmmod` of these three modules, and reads of `/dev/hwrng`.
- No u-boot env changes (`fw_setenv`), no flashing, no package installs, no `keyboard-device` restarts without asking Rob.
- Don't touch `/data/DeviceUpgradeFirmware` (Rob keeps that path).
- Leave `spi0.1` alone. `fb_gc9107t` may still be loaded there from the panel test.
- Commands get a timeout of 60 s or less; background anything longer and write its output to a file.
- Never push.
