// First-party macOS process cleanup for workspace execution. It never reads
// argv, environment, memory or user file contents. Ownership comes from two
// immutable permissions in this invocation's inherited Seatbelt profile, not
// from a PID, environment variable or process group supplied by a caller.
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/proc.h>
#include <sys/stat.h>
#include <sys/param.h>
#include <unistd.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <time.h>

// Darwin Sandbox SPI, also declared in WebKit's SandboxSPI.h. If the platform
// cannot prove these permissions, the caller's real sandbox probe fails closed.
extern int sandbox_check(pid_t, const char *, int, ...);
extern const int SANDBOX_CHECK_NO_REPORT;
#define FILTER_PATH 1

static int private_file(const char *name) {
  struct stat value = {0};
  return name[0] == '/' && lstat(name, &value) == 0 && S_ISREG(value.st_mode)
      && value.st_uid == getuid() && value.st_nlink == 1 && (value.st_mode & 077) == 0;
}
static int same_birth(const struct proc_bsdinfo *a, const struct proc_bsdinfo *b) {
  return a->pbi_pid == b->pbi_pid && a->pbi_uid == b->pbi_uid
      && a->pbi_start_tvsec == b->pbi_start_tvsec && a->pbi_start_tvusec == b->pbi_start_tvusec;
}
static int owned(pid_t pid, const char *marker, const char *guard, struct proc_bsdinfo *identity) {
  if (pid <= 1 || pid == getpid()
      || proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, identity, sizeof(*identity)) != (int)sizeof(*identity)
      || identity->pbi_uid != getuid() || identity->pbi_status == SZOMB) return 0;
  int filter = FILTER_PATH | SANDBOX_CHECK_NO_REPORT;
  // Unsandboxed processes can read both files. Other sandbox profiles cannot
  // read the fresh per-invocation marker. Only this profile has allow/deny.
  return sandbox_check(pid, "file-read-data", filter, marker) == 0
      && sandbox_check(pid, "file-read-data", filter, guard) == 1;
}
static int sweep(const char *marker, const char *guard, unsigned *killed) {
  int bytes = proc_listpids(PROC_ALL_PIDS, 0, NULL, 0);
  if (bytes <= 0 || bytes > 4 * 1024 * 1024) return -1;
  bytes += 4096;
  pid_t *pids = calloc(1, (size_t)bytes);
  if (!pids) return -1;
  int count = proc_listpids(PROC_ALL_PIDS, 0, pids, bytes);
  if (count <= 0) { free(pids); return -1; }
  int found = 0;
  for (int i = 0; i < count / (int)sizeof(pid_t); i++) {
    struct proc_bsdinfo before = {0}, after = {0};
    if (!owned(pids[i], marker, guard, &before)) continue;
    if (!owned(pids[i], marker, guard, &after) || !same_birth(&before, &after)) continue;
    found++;
    if (kill(pids[i], SIGKILL) == 0) (*killed)++;
    else if (errno != ESRCH) { free(pids); return -1; }
  }
  free(pids);
  return found;
}
int main(int argc, char **argv) {
  if (argc != 3 || !private_file(argv[1]) || !private_file(argv[2])
      || strcmp(argv[1], argv[2]) == 0) return 2;
  char left[PATH_MAX] = {0}, right[PATH_MAX] = {0};
  if (!realpath(argv[1], left) || !realpath(argv[2], right)) return 2;
  char *a = strrchr(left, '/'), *b = strrchr(right, '/');
  if (!a || !b) return 2;
  *a = 0; *b = 0;
  if (strcmp(left, right) != 0) return 2;
  unsigned killed = 0;
  for (unsigned attempt = 0; attempt < 100; attempt++) {
    int found = sweep(argv[1], argv[2], &killed);
    if (found < 0) return 3;
    if (found == 0) {
      printf("{\"version\":1,\"cleared\":true,\"terminated\":%u,\"argvOrEnvironmentQueried\":false}\n", killed);
      return 0;
    }
    struct timespec delay = { .tv_sec = 0, .tv_nsec = 10000000 };
    nanosleep(&delay, NULL);
  }
  return 4;
}
