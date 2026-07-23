/* The OS-facing half of the typed-array/Buffer runtime: fs Buffer reads/
 * writes (scr_lib.c's throw formatting), the fs/promises bytes form
 * (scr_async.c's settled-promise minting), crypto.randomBytes, and the
 * process stream Buffer writes. Split from scr_bytes.c so the pure bytes
 * core links without the lib/async runtimes (the runtime unit tests link
 * exact source lists). */
#include "scr_runtime.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void scr_bytes_io_oom(void) {
  scr_trap("scriptc: out of memory\n");
}

/* ── fs (the Buffer forms of scr_lib.c's utf8 pair) ────────────────────── */

ScrBytes *scr_fs_read_file_bytes(ScrStr *path) {
  FILE *f = fopen(path->data, "rb");
  if (!f) {
    scr_fs_throw(errno, "open", path);
    return NULL;
  }
  size_t cap = 4096, len = 0;
  uint8_t *buf = malloc(cap);
  if (!buf) scr_bytes_io_oom();
  for (;;) {
    if (cap - len < 2048) {
      cap *= 2;
      uint8_t *grown = realloc(buf, cap);
      if (!grown) scr_bytes_io_oom();
      buf = grown;
    }
    size_t n = fread(buf + len, 1, cap - len, f);
    len += n;
    if (n == 0) break;
  }
  if (ferror(f)) {
    int e = errno;
    fclose(f);
    free(buf);
    scr_fs_throw(e, "read", path);
    return NULL;
  }
  fclose(f);
  ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, (double)len);
  memcpy(b->data, buf, len);
  free(buf);
  return b;
}

/* readFileSync's runtime-encoding form (a JS helper's untyped `enc`
 * parameter — test/common fixtures.js): undefined/null answer a Buffer,
 * utf8 answers a string, Node's other real encodings meet the loud
 * not-supported ladder, unknown names throw ERR_UNKNOWN_ENCODING, and an
 * options object dispatches on its `encoding` member (Node's form). +1
 * DOM value, or NULL with the exception pending. */
ScrDyn *scr_fs_read_file_sync_dyn(ScrStr *path, const ScrDyn *enc) {
  if (enc->kind == SCR_DYN_OBJ) {
    ScrDyn *ev = scr_dyn_obj_get((ScrDyn *)enc, "encoding", 8); /* borrowed */
    return scr_fs_read_file_sync_dyn(path, ev ? ev : scr_dyn_undefined());
  }
  if (enc->kind == SCR_DYN_UNDEF || enc->kind == SCR_DYN_NULL) {
    ScrBytes *b = scr_fs_read_file_bytes(path);
    if (!b) return NULL;
    ScrDyn *d = scr_dyn_new_buffer_copy(b);
    scr_bytes_release(b);
    return d;
  }
  if (enc->kind == SCR_DYN_STR) {
    const ScrStr *e = enc->v.str;
    if ((e->len == 4 && memcmp(e->data, "utf8", 4) == 0) ||
        (e->len == 5 && memcmp(e->data, "utf-8", 5) == 0)) {
      ScrStr *text = scr_fs_read_file(path);
      if (!text) return NULL;
      ScrDyn *d = scr_dyn_new_str(text);
      scr_str_release(text);
      return d;
    }
    static const char *const known[] = { "ascii", "latin1", "binary", "base64",
      "base64url", "hex", "ucs2", "ucs-2", "utf16le", "utf-16le", NULL };
    for (size_t i = 0; known[i]; i++) {
      if (e->len == strlen(known[i]) && memcmp(e->data, known[i], e->len) == 0) {
        char msg[128];
        int n = snprintf(msg, sizeof msg,
                         "readFileSync with encoding '%s' is not supported yet (only 'utf8' and Buffer reads here)",
                         known[i]);
        scr_throw_error_msg(SCR_ERR_ERROR, msg, (size_t)n);
        return NULL;
      }
    }
    char msg[128];
    int n = snprintf(msg, sizeof msg, "Unknown encoding: %.*s",
                     (int)(e->len < 64 ? e->len : 64), e->data);
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, (size_t)n, "ERR_UNKNOWN_ENCODING");
    return NULL;
  }
  {
    /* Kind rendering stays local: scr_dyn_specific_type lives in the
     * net/emitter-gated handle unit and this one links with bare fs. */
    const char *msg = "The \"options\" argument must be of type string or an instance of Object";
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, strlen(msg), "ERR_INVALID_ARG_TYPE");
    return NULL;
  }
}

void scr_fs_write_file_bytes(ScrStr *path, const ScrBytes *data) {
  FILE *f = fopen(path->data, "wb");
  if (!f) {
    scr_fs_throw(errno, "open", path);
    return;
  }
  size_t n = data->len * scr_bytes_elem_size(data->elem);
  if (n > 0 && fwrite(data->data, 1, n, f) != n) {
    int e = errno;
    fclose(f);
    scr_fs_throw(e, "write", path);
    return;
  }
  if (fclose(f) != 0) scr_fs_throw(errno, "close", path);
}

ScrPromise *scr_fsp_read_file_bytes(ScrStr *path) {
  ScrBytes *b = scr_fs_read_file_bytes(path);
  return scr_promise_settled_ref(b, &scr_bytes_retain_v, &scr_bytes_release_v, NULL);
}

/* ── crypto.randomBytes → a real Buffer ────────────────────────────────── */

ScrBytes *scr_crypto_random_bytes(double n) {
  if (!(n >= 0 && n <= 2147483647)) {
    char num[32];
    size_t numlen = scr_f64_to_str(n, num);
    char msg[128];
    int mlen = snprintf(
        msg, sizeof msg,
        "The value of \"size\" is out of range. It must be >= 0 && <= 2147483647. Received %.*s",
        (int)numlen, num);
    scr_throw_error_msg(SCR_ERR_RANGE, msg, (size_t)mlen);
    return NULL;
  }
  ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, n);
  if (b->len > 0) arc4random_buf(b->data, b->len);
  return b;
}

/* ── process.stdout/stderr.write(buf) ──────────────────────────────────── */

bool scr_process_stdout_write_bytes(const ScrBytes *b) {
  fwrite(b->data, 1, b->len * scr_bytes_elem_size(b->elem), stdout);
  return true;
}

bool scr_process_stderr_write_bytes(const ScrBytes *b) {
  fflush(stdout); /* merged 2>&1 output keeps source order (scr_lib.c) */
  fwrite(b->data, 1, b->len * scr_bytes_elem_size(b->elem), stderr);
  return true;
}
