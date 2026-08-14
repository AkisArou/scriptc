/* Native IR opaque handles. The foreign pointer never becomes a TypeScript
 * value: generated code owns this refcounted cell and asks it for a borrowed
 * pointer only for the duration of one validated native call.
 *
 * Disposal is synchronous and idempotent. Clearing `foreign` before invoking
 * the destructor makes re-entrant disposal harmless and ensures the automatic
 * last-reference path cannot destroy the same native resource twice. */
#include "scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>

struct ScrNativeHandle {
  size_t rc;
  void *foreign;
  ScrNativeDestructor destructor;
  const void *type_tag;
  const char *type_name;
};

static void scr_native_handle_type_error(const ScrNativeHandle *handle,
                                         const char *operation,
                                         const char *detail) {
  const char *name = handle && handle->type_name ? handle->type_name : "native handle";
  const char *op = operation ? operation : "native operation";
  char message[384];
  int len = snprintf(message, sizeof message, "%s cannot use %s: %s", op, name, detail);
  size_t n = len < 0 ? 0 : (size_t)len < sizeof message ? (size_t)len : sizeof message - 1;
  scr_throw_error_msg(SCR_ERR_TYPE, message, n);
}

ScrNativeHandle *scr_native_handle_new(void *foreign,
                                       ScrNativeDestructor destructor,
                                       const void *type_tag,
                                       const char *type_name) {
  if (!foreign) {
    ScrNativeHandle description = {0, NULL, destructor, type_tag, type_name};
    scr_native_handle_type_error(&description, "native constructor",
                                 "the binding returned a null pointer");
    return NULL;
  }
  if (!destructor || !type_tag) scr_trap("scriptc: invalid native handle metadata\n");
  ScrNativeHandle *handle = malloc(sizeof *handle);
  if (!handle) scr_trap("scriptc: out of memory\n");
  handle->rc = 1;
  handle->foreign = foreign;
  handle->destructor = destructor;
  handle->type_tag = type_tag;
  handle->type_name = type_name;
  scr_obj_alloc_note();
  return handle;
}

ScrNativeHandle *scr_native_handle_retain(ScrNativeHandle *handle) {
  if (handle && handle->rc != SIZE_MAX) handle->rc++;
  return handle;
}

static void scr_native_handle_destroy_foreign(ScrNativeHandle *handle) {
  void *foreign = handle->foreign;
  if (!foreign) return;
  handle->foreign = NULL;
  handle->destructor(foreign);
}

void scr_native_handle_release(ScrNativeHandle *handle) {
  if (!handle || handle->rc == SIZE_MAX) return;
  if (--handle->rc != 0) return;
  scr_native_handle_destroy_foreign(handle);
  scr_obj_free_note();
  free(handle);
}

void *scr_native_handle_retain_v(void *handle) {
  return scr_native_handle_retain(handle);
}

void scr_native_handle_release_v(void *handle) {
  scr_native_handle_release(handle);
}

static bool scr_native_handle_valid_type(ScrNativeHandle *handle,
                                         const void *type_tag,
                                         const char *operation) {
  if (!handle || handle->type_tag != type_tag) {
    scr_native_handle_type_error(handle, operation, "the handle has the wrong nominal type");
    return false;
  }
  return true;
}

void *scr_native_handle_require(ScrNativeHandle *handle,
                                const void *type_tag,
                                const char *operation) {
  if (!scr_native_handle_valid_type(handle, type_tag, operation)) return NULL;
  if (!handle->foreign) {
    scr_native_handle_type_error(handle, operation, "the handle is already disposed");
    return NULL;
  }
  return handle->foreign;
}

void scr_native_handle_dispose(ScrNativeHandle *handle,
                               const void *type_tag,
                               const char *operation) {
  if (!scr_native_handle_valid_type(handle, type_tag, operation)) return;
  scr_native_handle_destroy_foreign(handle);
}
