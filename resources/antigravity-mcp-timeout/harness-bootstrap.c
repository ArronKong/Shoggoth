// Preserve the Google harness PID/ppid while a private child authenticates the
// bounded stdio startup frame with Shoggoth. No MCP, WebSocket or protobuf
// contents are interpreted here. All diagnostics are fixed, payload-free codes.
#define _DARWIN_C_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

extern char **environ;
#define FRAME_LIMIT 16384U
#ifndef IO_TIMEOUT_MS
#define IO_TIMEOUT_MS 30000
#endif
#define CHECK_INTERVAL_MS 100
static volatile sig_atomic_t stopped = 0;
static void stop_signal(int value) { (void)value; stopped = 1; }
static int64_t now_ms(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) return -1;
  return (int64_t)value.tv_sec * 1000 + value.tv_nsec / 1000000;
}
static void diagnostic(const char *code) {
  // These strings are literals, never paths, tokens, payloads or errno text.
  (void)write(STDERR_FILENO, code, strlen(code));
}
static int nonblocking(int fd) {
  int value = fcntl(fd, F_GETFL);
  return value >= 0 && fcntl(fd, F_SETFL, value | O_NONBLOCK) == 0;
}
static int cloexec(int fd) {
  int value = fcntl(fd, F_GETFD);
  return value >= 0 && fcntl(fd, F_SETFD, value | FD_CLOEXEC) == 0;
}
static int copy_path(const char *input, char *output, size_t size) {
  if (!input || input[0] != '/' || strlen(input) >= size) return 0;
  char resolved[PATH_MAX];
  if (!realpath(input, resolved) || strcmp(input, resolved) != 0) return 0;
  memcpy(output, input, strlen(input) + 1);
  return 1;
}
static int executable_path(const char *input, char *output, size_t size) {
  struct stat info;
  return copy_path(input, output, size) && lstat(output, &info) == 0
    && S_ISREG(info.st_mode) && access(output, X_OK) == 0;
}
static int socket_path(const char *input, char *output, size_t size) {
  struct stat info;
  if (!copy_path(input, output, size) || lstat(output, &info) != 0
    || !S_ISSOCK(info.st_mode) || info.st_uid != geteuid() || (info.st_mode & 0077) != 0) return 0;
  char directory[PATH_MAX];
  memcpy(directory, output, strlen(output) + 1);
  char *last = strrchr(directory, '/');
  if (!last || last == directory) return 0;
  *last = '\0';
  return lstat(directory, &info) == 0 && S_ISDIR(info.st_mode)
    && info.st_uid == geteuid() && (info.st_mode & 0077) == 0;
}
static int token_value(const char *input, char token[65]) {
  if (!input || strlen(input) != 64) return 0;
  for (size_t i = 0; i < 64; i++) {
    char value = input[i];
    if (!((value >= '0' && value <= '9') || (value >= 'a' && value <= 'f'))) return 0;
  }
  memcpy(token, input, 65);
  return 1;
}
static int parent_alive(pid_t parent) { return !stopped && getppid() == parent; }

// A control byte or EOF outside the one expected reply is always a stop.
// The relay never accepts an executable, command or restart instruction.
static int wait_fd(int fd, short events, int control, pid_t parent, int64_t deadline) {
  while (parent_alive(parent)) {
    int64_t remaining = deadline - now_ms();
    if (remaining <= 0) return 0;
    struct pollfd fds[2] = {{fd, events, 0}, {control, POLLIN, 0}};
    nfds_t count = control >= 0 && control != fd ? 2 : 1;
    int timeout = remaining < CHECK_INTERVAL_MS ? (int)remaining : CHECK_INTERVAL_MS;
    int result = poll(fds, count, timeout);
    if (result < 0 && errno == EINTR) continue;
    if (result < 0) return 0;
    if (count == 2 && fds[1].revents != 0) return 0;
    if (fds[0].revents & (POLLERR | POLLNVAL)) return 0;
    if (fds[0].revents & (events | POLLHUP)) return 1;
  }
  return 0;
}
static int read_all(int fd, void *data, size_t size, int control, pid_t parent, int64_t deadline) {
  unsigned char *bytes = data;
  while (size > 0) {
    if (!wait_fd(fd, POLLIN, control, parent, deadline)) return 0;
    ssize_t got = read(fd, bytes, size);
    if (got < 0 && (errno == EINTR || errno == EAGAIN)) continue;
    if (got <= 0) return 0;
    bytes += got; size -= (size_t)got;
  }
  return 1;
}
static int write_all(int fd, const void *data, size_t size, int control, pid_t parent, int64_t deadline) {
  const unsigned char *bytes = data;
  while (size > 0) {
    if (!wait_fd(fd, POLLOUT, control, parent, deadline)) return 0;
    ssize_t sent = write(fd, bytes, size);
    if (sent < 0 && (errno == EINTR || errno == EAGAIN)) continue;
    if (sent <= 0) return 0;
    bytes += sent; size -= (size_t)sent;
    // Bound stalled writes, while allowing a consumer that keeps making progress.
    deadline = now_ms() + IO_TIMEOUT_MS;
  }
  return 1;
}
static uint32_t decode_size(const unsigned char header[4]) {
  return (uint32_t)header[0] | ((uint32_t)header[1] << 8)
    | ((uint32_t)header[2] << 16) | ((uint32_t)header[3] << 24);
}
static void encode_size(uint32_t size, unsigned char header[4]) {
  header[0] = (unsigned char)size; header[1] = (unsigned char)(size >> 8);
  header[2] = (unsigned char)(size >> 16); header[3] = (unsigned char)(size >> 24);
}
static int send_frame(int fd, const void *bytes, uint32_t size, int control, pid_t parent, int64_t deadline) {
  unsigned char header[4]; encode_size(size, header);
  return write_all(fd, header, sizeof(header), control, parent, deadline)
    && write_all(fd, bytes, size, control, parent, deadline);
}
static int connect_control(const char *path, pid_t parent, int64_t deadline) {
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  if (!cloexec(fd) || !nonblocking(fd)) { close(fd); return -1; }
  struct sockaddr_un address; memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  memcpy(address.sun_path, path, strlen(path) + 1);
  int result = connect(fd, (const struct sockaddr *)&address, sizeof(address));
  if (result != 0 && errno != EINPROGRESS) { close(fd); return -1; }
  if (result != 0) {
    int error = 0; socklen_t length = sizeof(error);
    if (!wait_fd(fd, POLLOUT, -1, parent, deadline)
      || getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &length) != 0 || error != 0) { close(fd); return -1; }
  }
  return fd;
}
static void stop_parent(pid_t parent) {
  // getppid is the authority for this child: a reparented relay may never kill
  // the numeric old PID (which could already have been reused).
  if (getppid() != parent) return;
  (void)kill(parent, SIGTERM);
  int64_t end = now_ms() + 1500;
  while (getppid() == parent && now_ms() < end) {
    struct timespec pause = {0, 20000000}; (void)nanosleep(&pause, NULL);
  }
  if (getppid() == parent) (void)kill(parent, SIGKILL);
}
static void relay(pid_t parent, int input, const char *path, char token[65]) {
  (void)close(STDIN_FILENO);
  (void)signal(SIGPIPE, SIG_IGN);
  (void)signal(SIGTERM, stop_signal); (void)signal(SIGINT, stop_signal);
  int control = -1, success = 0;
  int64_t deadline = now_ms() + IO_TIMEOUT_MS;
  unsigned char body[FRAME_LIMIT], header[4];
  if (!nonblocking(input) || !nonblocking(STDOUT_FILENO)) goto done;
  control = connect_control(path, parent, deadline);
  if (control < 0) goto done;
  char metadata[256];
  int length = snprintf(metadata, sizeof(metadata), "{\"version\":1,\"token\":\"%s\",\"harnessPid\":%ld,\"relayPid\":%ld}", token, (long)parent, (long)getpid());
  if (length <= 0 || (size_t)length >= sizeof(metadata)
    || !send_frame(control, metadata, (uint32_t)length, -1, parent, deadline)) goto done;
  memset(token, 0, 65); memset(metadata, 0, sizeof(metadata));
  if (!read_all(input, header, sizeof(header), control, parent, deadline)) goto done;
  uint32_t size = decode_size(header);
  if (size == 0 || size > FRAME_LIMIT || !read_all(input, body, size, control, parent, deadline)
    || !send_frame(control, body, size, -1, parent, deadline)) goto done;
  if (!read_all(control, header, sizeof(header), -1, parent, deadline)) goto done;
  size = decode_size(header);
  if (size == 0 || size > FRAME_LIMIT || !read_all(control, body, size, -1, parent, deadline)
    || !send_frame(STDOUT_FILENO, body, size, control, parent, deadline)) goto done;
  while (parent_alive(parent)) {
    // Reading idle stdout has no total timeout; cancellation remains responsive.
    if (!wait_fd(input, POLLIN, control, parent, now_ms() + IO_TIMEOUT_MS)) {
      if (parent_alive(parent)) {
        struct pollfd check = {control, POLLIN, 0};
        int checked = poll(&check, 1, 0);
        if (checked == 0) continue;
      }
      goto done;
    }
    ssize_t got = read(input, body, sizeof(body));
    if (got < 0 && (errno == EINTR || errno == EAGAIN)) continue;
    if (got < 0) goto done;
    if (got == 0) {
      // Startup stdout is independent of the WebSocket session. A harness may
      // close it deliberately and continue serving: only Host cancellation or
      // actual parent death can end this relay's authority.
      (void)close(STDOUT_FILENO);
      while (parent_alive(parent)) {
        struct pollfd check = {control, POLLIN, 0};
        int checked = poll(&check, 1, CHECK_INTERVAL_MS);
        if (checked < 0 && errno == EINTR) continue;
        if (checked != 0) goto done;
      }
      success = getppid() != parent;
      goto done;
    }
    if (!write_all(STDOUT_FILENO, body, (size_t)got, control, parent, now_ms() + IO_TIMEOUT_MS)) goto done;
  }
  success = 1;
done:
  memset(token, 0, 65);
  if (control >= 0) (void)close(control);
  (void)close(input); (void)close(STDOUT_FILENO);
  if (!success) stop_parent(parent);
  if (!success) diagnostic("SHOGGOTH_AGY_BOOTSTRAP_RELAY_STOPPED\n");
  _exit(success ? 0 : 125);
}

int main(int argc, char **argv) {
  (void)argv;
  char harness[PATH_MAX], control[sizeof(((struct sockaddr_un *)0)->sun_path)], token[65];
  if (argc != 1 || !executable_path(getenv("SHOGGOTH_AGY_HARNESS_PATH"), harness, sizeof(harness))
    || !socket_path(getenv("SHOGGOTH_AGY_TIMEOUT_SOCKET"), control, sizeof(control))
    || !token_value(getenv("SHOGGOTH_AGY_TIMEOUT_TOKEN"), token)) {
    diagnostic("SHOGGOTH_AGY_BOOTSTRAP_INVALID_ENV\n"); return 126;
  }
  if (unsetenv("SHOGGOTH_AGY_HARNESS_PATH") != 0 || unsetenv("SHOGGOTH_AGY_TIMEOUT_SOCKET") != 0
    || unsetenv("SHOGGOTH_AGY_TIMEOUT_TOKEN") != 0 || unsetenv("ANTIGRAVITY_HARNESS_PATH") != 0) {
    diagnostic("SHOGGOTH_AGY_BOOTSTRAP_ENV_FAILED\n"); return 126;
  }
  int output[2];
  if (pipe(output) != 0 || !cloexec(output[0]) || !cloexec(output[1])) {
    diagnostic("SHOGGOTH_AGY_BOOTSTRAP_PIPE_FAILED\n"); return 126;
  }
  pid_t original = getpid();
  pid_t child = fork();
  if (child < 0) { diagnostic("SHOGGOTH_AGY_BOOTSTRAP_FORK_FAILED\n"); return 126; }
  if (child == 0) { (void)close(output[1]); relay(original, output[0], control, token); }
  (void)close(output[0]);
  if (dup2(output[1], STDOUT_FILENO) < 0) { diagnostic("SHOGGOTH_AGY_BOOTSTRAP_DUP_FAILED\n"); return 126; }
  (void)close(output[1]); memset(token, 0, sizeof(token));
  char *arguments[] = {harness, NULL};
  execve(harness, arguments, environ);
  diagnostic("SHOGGOTH_AGY_BOOTSTRAP_EXEC_FAILED\n"); return 126;
}
