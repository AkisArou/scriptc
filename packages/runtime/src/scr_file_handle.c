/* The fs/promises FileHandle slice. Kept in its own gated translation unit
 * so programs that never open a handle retain the base runtime's size class.
 * Operations settle through scr_async.c's ordinary promise helpers: a pending
 * synchronous exception becomes a rejection with the same Error payload. */
#include "scr_runtime.h"

#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#ifdef _WIN32
#include <io.h>
#else
#include <unistd.h>
#endif

#ifndef O_BINARY
#define O_BINARY 0
#endif
#ifndef O_SYNC
#define O_SYNC 0
#endif

/* One shared mutable descriptor slot gives aliases Node's close/fd behavior.
 * The last native reference closes a still-open descriptor; explicit close
 * reports errors through its promise wrapper instead. */
struct ScrFileHandle {
  size_t rc;
  int fd;
};

/* ScrStats is opaque at the public runtime boundary. FileHandle's fstat
 * snapshot completes the same layout privately in this translation unit. */
struct ScrStats {
  size_t rc;
  bool is_file;
  bool is_dir;
  bool is_symlink;
  double size;
  double mtime_ms;
};

static int scr_file_handle_open_flags(ScrStr *flags) {
  const char *f = flags->data;
  int of;
  if (strcmp(f, "r") == 0) of = O_RDONLY;
  else if (strcmp(f, "rs") == 0 || strcmp(f, "sr") == 0) of = O_RDONLY | O_SYNC;
  else if (strcmp(f, "r+") == 0) of = O_RDWR;
  else if (strcmp(f, "rs+") == 0 || strcmp(f, "sr+") == 0) of = O_RDWR | O_SYNC;
  else if (strcmp(f, "w") == 0) of = O_TRUNC | O_CREAT | O_WRONLY;
  else if (strcmp(f, "wx") == 0 || strcmp(f, "xw") == 0) of = O_TRUNC | O_CREAT | O_WRONLY | O_EXCL;
  else if (strcmp(f, "w+") == 0) of = O_TRUNC | O_CREAT | O_RDWR;
  else if (strcmp(f, "wx+") == 0 || strcmp(f, "xw+") == 0) of = O_TRUNC | O_CREAT | O_RDWR | O_EXCL;
  else if (strcmp(f, "a") == 0) of = O_APPEND | O_CREAT | O_WRONLY;
  else if (strcmp(f, "ax") == 0 || strcmp(f, "xa") == 0) of = O_APPEND | O_CREAT | O_WRONLY | O_EXCL;
  else if (strcmp(f, "as") == 0 || strcmp(f, "sa") == 0) of = O_APPEND | O_CREAT | O_WRONLY | O_SYNC;
  else if (strcmp(f, "a+") == 0) of = O_APPEND | O_CREAT | O_RDWR;
  else if (strcmp(f, "ax+") == 0 || strcmp(f, "xa+") == 0) of = O_APPEND | O_CREAT | O_RDWR | O_EXCL;
  else if (strcmp(f, "as+") == 0 || strcmp(f, "sa+") == 0) of = O_APPEND | O_CREAT | O_RDWR | O_SYNC;
  else {
    char msg[128];
    int len = snprintf(msg, sizeof msg,
                       "The argument 'flags' is invalid. Received '%s'", f);
    scr_throw_error_msg(SCR_ERR_TYPE, msg, (size_t)len);
    return -1;
  }
  return of;
}

ScrFileHandle *scr_file_handle_open(ScrStr *path, ScrStr *flags, double mode) {
  int of = scr_file_handle_open_flags(flags);
  if (of < 0) return NULL;
  int fd = open(path->data, of | O_BINARY, (mode_t)mode);
  if (fd < 0) {
    scr_fs_throw(errno, "open", path);
    return NULL;
  }
  ScrFileHandle *h = malloc(sizeof(ScrFileHandle));
  if (!h) scr_trap("scriptc: out of memory\n");
  h->rc = 1;
  h->fd = fd;
  return h;
}

ScrFileHandle *scr_file_handle_retain(ScrFileHandle *h) {
  if (h->rc != SIZE_MAX) h->rc++;
  return h;
}

void scr_file_handle_release(ScrFileHandle *h) {
  if (!h || h->rc == SIZE_MAX) return;
  if (--h->rc != 0) return;
  if (h->fd >= 0) (void)close(h->fd);
  free(h);
}

void *scr_file_handle_retain_v(void *p) { return scr_file_handle_retain(p); }
void scr_file_handle_release_v(void *p) { scr_file_handle_release(p); }

double scr_file_handle_fd(ScrFileHandle *h) { return (double)h->fd; }

static bool scr_file_handle_require_open(ScrFileHandle *h) {
  if (h->fd >= 0) return true;
  static const char msg[] = "file closed";
  scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "EBADF");
  return false;
}

void scr_file_handle_close(ScrFileHandle *h) {
  if (h->fd < 0) return; /* Node's FileHandle.close() is idempotent. */
  int fd = h->fd;
  h->fd = -1;
  scr_fs_close((double)fd);
}

double scr_file_handle_read(ScrFileHandle *h, ScrBytes *buf, double offset,
                            double length, double position,
                            bool length_default) {
  if (!scr_file_handle_require_open(h)) return 0;
  if (length_default && isfinite(offset) && trunc(offset) == offset &&
      offset >= 0 && offset <= (double)buf->len) {
    length = (double)buf->len - offset;
  }
  return scr_fs_read_sync((double)h->fd, buf, offset, length, position);
}

double scr_file_handle_write_bytes(ScrFileHandle *h, ScrBytes *buf,
                                   double offset, double length,
                                   double position, bool length_default) {
  if (!scr_file_handle_require_open(h)) return 0;
  if (length_default && isfinite(offset) && trunc(offset) == offset &&
      offset >= 0 && offset <= (double)buf->len) {
    length = (double)buf->len - offset;
  }
  return scr_fs_write_sync((double)h->fd, buf, offset, length, position);
}

double scr_file_handle_write_str(ScrFileHandle *h, ScrStr *data,
                                 double position, ScrStr *encoding) {
  if (!scr_file_handle_require_open(h)) return 0;
  return scr_fs_write_str_sync((double)h->fd, data, position, encoding);
}

ScrStr *scr_file_handle_read_file(ScrFileHandle *h) {
  if (!scr_file_handle_require_open(h)) return NULL;
  return scr_fs_read_fd((double)h->fd);
}

ScrBytes *scr_file_handle_read_file_bytes(ScrFileHandle *h) {
  if (!scr_file_handle_require_open(h)) return NULL;
  return scr_fs_read_fd_bytes((double)h->fd);
}

static void scr_file_handle_write_all(ScrFileHandle *h, const void *data,
                                      size_t length) {
  if (!scr_file_handle_require_open(h)) return;
  ScrBytes bytes = {SIZE_MAX, length, SCR_BYTES_U8, (uint8_t *)data, NULL};
  size_t at = 0;
  while (at < length) {
    double count = scr_fs_write_sync((double)h->fd, &bytes, (double)at,
                                     (double)(length - at), -1);
    if (scr_exc_pending()) return;
    if (count <= 0) {
      static const char msg[] = "EIO: i/o error, write";
      scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "EIO");
      return;
    }
    at += (size_t)count;
  }
}

void scr_file_handle_write_file(ScrFileHandle *h, ScrStr *data) {
  scr_file_handle_write_all(h, data->data, data->len);
}

void scr_file_handle_write_file_bytes(ScrFileHandle *h, ScrBytes *data) {
  scr_file_handle_write_all(h, data->data,
                            data->len * scr_bytes_elem_size(data->elem));
}

ScrStats *scr_file_handle_stat(ScrFileHandle *h) {
  if (!scr_file_handle_require_open(h)) return NULL;
  struct stat st;
  if (fstat(h->fd, &st) != 0) {
    int err = errno;
    const char *name = err == EBADF ? "EBADF" : err == EIO ? "EIO" : "EUNKNOWN";
    const char *text = err == EBADF ? "bad file descriptor" :
                       err == EIO ? "i/o error" : strerror(err);
    char msg[256];
    int len = snprintf(msg, sizeof msg, "%s: %s, fstat", name, text);
    scr_throw_error_msg_code(SCR_ERR_ERROR, msg, (size_t)len, name);
    return NULL;
  }
  ScrStats *out = malloc(sizeof(ScrStats));
  if (!out) scr_trap("scriptc: out of memory\n");
  out->rc = 1;
  out->is_file = S_ISREG(st.st_mode);
  out->is_dir = S_ISDIR(st.st_mode);
  out->is_symlink = false; /* fstat follows the open descriptor. */
  out->size = (double)st.st_size;
#if defined(_WIN32)
  out->mtime_ms = (double)st.st_mtime * 1000.0;
#elif defined(__APPLE__)
  out->mtime_ms = (double)st.st_mtimespec.tv_sec * 1000.0 +
                  (double)st.st_mtimespec.tv_nsec / 1e6;
#else
  out->mtime_ms = (double)st.st_mtim.tv_sec * 1000.0 +
                  (double)st.st_mtim.tv_nsec / 1e6;
#endif
  return out;
}

ScrPromise *scr_fsp_open(ScrStr *path, ScrStr *flags, double mode) {
  ScrFileHandle *h = scr_file_handle_open(path, flags, mode);
  return scr_promise_settled_ref(h, &scr_file_handle_retain_v,
                                 &scr_file_handle_release_v, NULL);
}

ScrPromise *scr_file_handle_close_promise(ScrFileHandle *h) {
  scr_file_handle_close(h);
  return scr_promise_settled_void();
}

ScrPromise *scr_file_handle_read_file_promise(ScrFileHandle *h,
                                              ScrStr *encoding) {
  (void)encoding;
  return scr_promise_settled_str(scr_file_handle_read_file(h));
}

ScrPromise *scr_file_handle_read_file_bytes_promise(ScrFileHandle *h) {
  ScrBytes *data = scr_file_handle_read_file_bytes(h);
  return scr_promise_settled_ref(data, &scr_bytes_retain_v,
                                 &scr_bytes_release_v, NULL);
}

ScrPromise *scr_file_handle_write_file_promise(ScrFileHandle *h,
                                               ScrStr *data,
                                               ScrStr *encoding) {
  (void)encoding; /* frontend admits utf8 only; evaluation is observable */
  scr_file_handle_write_file(h, data);
  return scr_promise_settled_void();
}

ScrPromise *scr_file_handle_write_file_bytes_promise(ScrFileHandle *h,
                                                     ScrBytes *data,
                                                     ScrStr *encoding) {
  (void)encoding;
  scr_file_handle_write_file_bytes(h, data);
  return scr_promise_settled_void();
}

ScrPromise *scr_file_handle_stat_promise(ScrFileHandle *h) {
  ScrStats *st = scr_file_handle_stat(h);
  return scr_promise_settled_ref(st, &scr_stats_retain_v,
                                 &scr_stats_release_v, NULL);
}
