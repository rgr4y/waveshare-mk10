// Drop-in for the stock /usr/bin/videoplayerinterfaceAPP (MK10, Allwinner T113) that can pause and swap.
// Same args and the same call sequence into /vendor/lib/libvideoplayerinterface.so (disassembled from
// the stock launcher; see docs/display-pipeline.md). Added:
//   SIGUSR1  toggle pause/play (freeze the current frame)
//   SIGUSR2  play the file named in SWAP_FILE, or the -f file when SWAP_FILE is empty or missing
// SWAP_FILE is removed at start, so a player restarted by KeyboardDevice begins on its own -f file.
// STATE_FILE holds "playing" or "paused" (MK10 Studio shows it); removed at exit.
// The stock launcher exits on SIGUSR1/SIGUSR2; this one only exits on INT/TERM/QUIT/HUP/PIPE.
//
// Build: see build.sh (zig cc, arm-linux-gnueabihf, glibc 2.23 like /vendor/lib).
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define SWAP_FILE "/run/mk10-background"
#define STATE_FILE "/run/mk10-vplayer-state"

// write then rename, so a reader never sees a half-written file
static void put_state(int paused) {
  FILE *f = fopen(STATE_FILE ".tmp", "w");
  if (!f) return;
  fputs(paused ? "paused\n" : "playing\n", f);
  if (fclose(f) == 0) rename(STATE_FILE ".tmp", STATE_FILE);
}

// C++ members of class videoplayerinterface, called with `this` as the first argument (ARM EABI).
#define VPI(ret, name, sym, ...) extern ret name(void *self, ##__VA_ARGS__) __asm__(sym)
VPI(void *, vp_ctor, "_ZN20videoplayerinterfaceC1Ev");
VPI(void *, vp_dtor, "_ZN20videoplayerinterfaceD1Ev");
VPI(int, vp_create, "_ZN20videoplayerinterface6createENS_16EVideoPlayerTypeE", int type);
VPI(int, vp_destroy, "_ZN20videoplayerinterface7destroyEv");
VPI(int, vp_rect, "_ZN20videoplayerinterface14setDisplayRectEiijj", int x, int y, unsigned w, unsigned h);
VPI(int, vp_notify, "_ZN20videoplayerinterface37videoPlayerInterfaceSetNotifyCallbackEPFiPviiS0_ES0_",
    int (*cb)(void *, int, int, void *), void *user);
VPI(int, vp_reset, "_ZN20videoplayerinterface5resetEv");
VPI(int, vp_rotate, "_ZN20videoplayerinterface9setRotateE19VideoRotateType_VPI", int rotate);
VPI(int, vp_source, "_ZN20videoplayerinterface13setDataSourceEPKcPK19CdxKeyedVectorS_VPI", const char *url, const void *headers);
VPI(int, vp_prepare, "_ZN20videoplayerinterface7prepareEv");
VPI(int, vp_hold, "_ZN20videoplayerinterface18setHoldLastPictureEi", int hold);
VPI(int, vp_loop, "_ZN20videoplayerinterface10setLoopingEb", int loop);
VPI(int, vp_play, "_ZN20videoplayerinterface4playEv");
VPI(int, vp_pause, "_ZN20videoplayerinterface5pauseEv");

// the stock launcher allocates 4 bytes (operator new(4)); 64 leaves slack
static long obj[16];

// the stock callback returns 0 and does nothing else
static int on_notify(void *user, int msg, int ext, void *param) { (void)user; (void)msg; (void)ext; (void)param; return 0; }

int main(int argc, char **argv) {
  int x = 0, y = 0, w = 0, h = 0, rotate = 0, c;
  char file[256] = "";
  while ((c = getopt(argc, argv, "x:y:w:h:f:r:")) != -1) {
    switch (c) {
      case 'x': x = atoi(optarg); break;
      case 'y': y = atoi(optarg); break;
      case 'w': w = atoi(optarg); break;
      case 'h': h = atoi(optarg); break;
      case 'r': rotate = atoi(optarg); break;
      case 'f': strncpy(file, optarg, sizeof file - 1); break;
      default:
        fprintf(stderr, "usage: %s -x X -y Y -w W -h H -f FILE [-r ROTATE]\n", argv[0]);
        return 1;
    }
  }
  if (!w || !h || !file[0]) {
    fprintf(stderr, "need -w, -h and -f\n");
    return 1;
  }
  unlink(SWAP_FILE);
  printf("vplayer: %s at %d,%d %dx%d rotate %d (SIGUSR1 pause, SIGUSR2 swap)\n", file, x, y, w, h, rotate);
  fflush(stdout);

  // handle signals synchronously, so library calls never run inside a signal handler
  sigset_t set;
  sigemptyset(&set);
  int sigs[] = { SIGINT, SIGTERM, SIGQUIT, SIGHUP, SIGPIPE, SIGUSR1, SIGUSR2 };
  for (unsigned i = 0; i < sizeof sigs / sizeof *sigs; i++) sigaddset(&set, sigs[i]);
  sigprocmask(SIG_BLOCK, &set, NULL); // before create(), so the player's threads inherit the mask

  void *vp = obj;
  vp_ctor(vp);
  vp_create(vp, 0);
  vp_rect(vp, x, y, (unsigned)w, (unsigned)h);
  vp_notify(vp, on_notify, NULL);
  vp_reset(vp);
  vp_rotate(vp, rotate);
  vp_source(vp, file, NULL);
  vp_prepare(vp);
  vp_hold(vp, 0);
  vp_loop(vp, 1);
  vp_play(vp);

  int paused = 0, sig;
  put_state(0);
  for (;;) {
    if (sigwait(&set, &sig)) continue;
    if (sig == SIGUSR1) {
      paused = !paused;
      int rc = paused ? vp_pause(vp) : vp_play(vp);
      put_state(paused);
      printf("vplayer: %s (rc %d)\n", paused ? "paused" : "playing", rc);
    } else if (sig == SIGUSR2) {
      char want[256] = "";
      FILE *f = fopen(SWAP_FILE, "r");
      if (f) {
        if (!fgets(want, sizeof want, f)) want[0] = 0;
        fclose(f);
        want[strcspn(want, "\r\n")] = 0;
      }
      const char *src = want[0] ? want : file;
      if (access(src, R_OK)) {
        printf("vplayer: can't read %s, keeping the current video\n", src);
      } else {
        // the stock order from reset() on; the display rect and notify callback stay set
        vp_reset(vp);
        vp_rotate(vp, rotate);
        int rc = vp_source(vp, src, NULL);
        vp_prepare(vp);
        vp_hold(vp, 0);
        vp_loop(vp, 1);
        vp_play(vp);
        paused = 0;
        put_state(0);
        printf("vplayer: now playing %s (setDataSource rc %d)\n", src, rc);
      }
    } else break;
    fflush(stdout);
  }
  printf("vplayer: signal %d, exiting\n", sig);
  unlink(STATE_FILE);
  vp_destroy(vp);
  vp_dtor(vp);
  return 1; // the stock launcher exit(1)s on every signal
}
