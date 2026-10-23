// Task-owned macOS test fixture. No argv, environment, memory or file contents
// are queried. The only targets are this process's actual parent and its next
// two ancestors, resolved from the OS rather than caller-supplied PIDs.
// Primary declarations: macOS SDK libproc.h and sys/proc_info.h.
#include <libproc.h>
#include <sys/proc_info.h>
#include <unistd.h>
#include <stdio.h>
#include <stdint.h>
#include <inttypes.h>
#include <string.h>
#include <errno.h>

struct process_fact {
  struct proc_bsdinfo identity;
  char executable[PROC_PIDPATHINFO_MAXSIZE];
};

static int same_identity(const struct proc_bsdinfo *a, const struct proc_bsdinfo *b) {
  return a->pbi_pid == b->pbi_pid && a->pbi_ppid == b->pbi_ppid
      && a->pbi_pgid == b->pbi_pgid && a->pbi_uid == b->pbi_uid
      && a->pbi_start_tvsec == b->pbi_start_tvsec
      && a->pbi_start_tvusec == b->pbi_start_tvusec;
}

static int read_fact(pid_t pid, struct process_fact *fact) {
  struct proc_bsdinfo before = {0}, after = {0};
  if (pid <= 1 || proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &before, sizeof(before)) != (int)sizeof(before)
      || proc_pidpath(pid, fact->executable, sizeof(fact->executable)) <= 0
      || proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &after, sizeof(after)) != (int)sizeof(after)
      || !same_identity(&before, &after) || after.pbi_pid != (uint32_t)pid
      || after.pbi_uid != getuid() || fact->executable[0] != '/') return 0;
  fact->identity = after;
  return 1;
}

static void json_string(const char *value) {
  putchar('"');
  for (const unsigned char *p = (const unsigned char *)value; *p; ++p) {
    if (*p == '"' || *p == '\\') { putchar('\\'); putchar(*p); }
    else if (*p < 32) printf("\\u%04x", *p);
    else putchar(*p);
  }
  putchar('"');
}

static void print_fact(const struct process_fact *fact) {
  const struct proc_bsdinfo *row = &fact->identity;
  char command_name[sizeof(row->pbi_comm) + 1] = {0};
  memcpy(command_name, row->pbi_comm, sizeof(row->pbi_comm));
  printf("{\"pid\":%u,\"ppid\":%u,\"pgid\":%u,\"uid\":%u,\"birthEpochSeconds\":%" PRIu64
      ",\"birthMicroseconds\":%" PRIu64 ",\"executable\":", row->pbi_pid, row->pbi_ppid,
      row->pbi_pgid, (unsigned)row->pbi_uid, row->pbi_start_tvsec, row->pbi_start_tvusec);
  json_string(fact->executable);
  printf(",\"commandName\":");
  json_string(command_name);
  putchar('}');
}

int main(void) {
  struct process_fact facts[3] = {0};
  pid_t pid = getppid();
  for (unsigned i = 0; i < 3; ++i) {
    if (!read_fact(pid, &facts[i])) {
      printf("{\"version\":1,\"errorCode\":\"AGY_KERNEL_OS_METADATA_QUERY_FAILED\",\"errno\":%d}\n", errno);
      return 2;
    }
    pid = (pid_t)facts[i].identity.pbi_ppid;
  }
  // Recheck every identity after the chain is assembled to reject PID reuse
  // and reparenting between individual reads.
  for (unsigned i = 0; i < 3; ++i) {
    struct proc_bsdinfo current = {0};
    if (proc_pidinfo((pid_t)facts[i].identity.pbi_pid, PROC_PIDTBSDINFO, 0, &current, sizeof(current)) != (int)sizeof(current)
        || !same_identity(&facts[i].identity, &current)) {
      puts("{\"version\":1,\"errorCode\":\"AGY_KERNEL_OS_METADATA_IDENTITY_CHANGED\"}");
      return 3;
    }
  }
  printf("{\"version\":1,\"identityStable\":true,\"argvOrEnvironmentQueried\":false,\"processes\":[");
  for (unsigned i = 0; i < 3; ++i) { if (i) putchar(','); print_fact(&facts[i]); }
  puts("]}");
  return 0;
}
