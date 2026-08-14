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

typedef struct ScrNativeLifecycleEdge {
  void *context;
  ScrNativeLifecycleFn commit;
  ScrNativeLifecycleFn abandon;
  ScrNativeLifecycleFn begin;
  ScrNativeLifecycleFn complete;
  ScrNativeLifecycleFn destroy_context;
  struct ScrNativeLifecycleEdge *next;
} ScrNativeLifecycleEdge;

typedef enum {
  SCR_NATIVE_HANDLE_PREPARED,
  SCR_NATIVE_HANDLE_LIVE,
  SCR_NATIVE_HANDLE_DISPOSED,
} ScrNativeHandleState;

struct ScrNativeHandle {
  size_t rc;
  void *foreign;
  ScrNativeDestructor destructor;
  const void *type_tag;
  const char *type_name;
  ScrNativeLifecycleEdge *lifecycle;
  ScrNativeHandleState state;
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

ScrNativeHandle *scr_native_handle_prepare(ScrNativeDestructor destructor,
                                           const void *type_tag,
                                           const char *type_name) {
  if (!destructor || !type_tag) scr_trap("scriptc: invalid native handle metadata\n");
  ScrNativeHandle *handle = malloc(sizeof *handle);
  if (!handle) scr_trap("scriptc: out of memory\n");
  handle->rc = 1;
  handle->foreign = NULL;
  handle->destructor = destructor;
  handle->type_tag = type_tag;
  handle->type_name = type_name;
  handle->lifecycle = NULL;
  handle->state = SCR_NATIVE_HANDLE_PREPARED;
  scr_obj_alloc_note();
  return handle;
}

ScrNativeHandle *scr_native_handle_retain(ScrNativeHandle *handle) {
  if (handle && handle->rc != SIZE_MAX) handle->rc++;
  return handle;
}

static void scr_native_handle_destroy_prepared(ScrNativeHandle *handle) {
  ScrNativeLifecycleEdge *lifecycle = handle->lifecycle;
  handle->lifecycle = NULL;
  handle->state = SCR_NATIVE_HANDLE_DISPOSED;
  while (lifecycle != NULL) {
    ScrNativeLifecycleEdge *next = lifecycle->next;
    lifecycle->abandon(lifecycle->context);
    lifecycle->destroy_context(lifecycle->context);
    free(lifecycle);
    lifecycle = next;
  }
}

static void scr_native_handle_destroy_foreign(ScrNativeHandle *handle) {
  if (handle->state != SCR_NATIVE_HANDLE_LIVE) return;
  ScrNativeLifecycleEdge *lifecycle = handle->lifecycle;
  handle->lifecycle = NULL;
  for (ScrNativeLifecycleEdge *edge = lifecycle; edge != NULL;
       edge = edge->next) {
    edge->begin(edge->context);
  }
  void *foreign = handle->foreign;
  handle->foreign = NULL;
  handle->state = SCR_NATIVE_HANDLE_DISPOSED;
  handle->destructor(foreign);
  while (lifecycle != NULL) {
    ScrNativeLifecycleEdge *next = lifecycle->next;
    lifecycle->complete(lifecycle->context);
    lifecycle->destroy_context(lifecycle->context);
    free(lifecycle);
    lifecycle = next;
  }
}

void scr_native_handle_prepare_lifecycle(
    ScrNativeHandle *handle, void *context, ScrNativeLifecycleFn commit,
    ScrNativeLifecycleFn abandon, ScrNativeLifecycleFn begin,
    ScrNativeLifecycleFn complete, ScrNativeLifecycleFn destroy_context) {
  if (handle == NULL || handle->state != SCR_NATIVE_HANDLE_PREPARED ||
      context == NULL || commit == NULL || abandon == NULL || begin == NULL ||
      complete == NULL || destroy_context == NULL) {
    scr_trap("scriptc: invalid native lifecycle edge\n");
  }
  ScrNativeLifecycleEdge *edge = malloc(sizeof *edge);
  if (edge == NULL) scr_trap("scriptc: out of memory\n");
  edge->context = context;
  edge->commit = commit;
  edge->abandon = abandon;
  edge->begin = begin;
  edge->complete = complete;
  edge->destroy_context = destroy_context;
  edge->next = handle->lifecycle;
  handle->lifecycle = edge;
}

void scr_native_handle_commit(ScrNativeHandle *handle, void *foreign) {
  if (handle == NULL || handle->state != SCR_NATIVE_HANDLE_PREPARED ||
      foreign == NULL) {
    scr_trap("scriptc: invalid native handle commit\n");
  }
  handle->foreign = foreign;
  handle->state = SCR_NATIVE_HANDLE_LIVE;
  for (ScrNativeLifecycleEdge *edge = handle->lifecycle; edge != NULL;
       edge = edge->next) {
    edge->commit(edge->context);
  }
}

void scr_native_handle_abandon(ScrNativeHandle *handle) {
  if (handle == NULL || handle->state != SCR_NATIVE_HANDLE_PREPARED ||
      handle->rc != 1) {
    scr_trap("scriptc: invalid native handle abandonment\n");
  }
  scr_native_handle_release(handle);
}

void scr_native_handle_release(ScrNativeHandle *handle) {
  if (!handle || handle->rc == SIZE_MAX) return;
  if (--handle->rc != 0) return;
  if (handle->state == SCR_NATIVE_HANDLE_PREPARED) {
    scr_native_handle_destroy_prepared(handle);
  } else {
    scr_native_handle_destroy_foreign(handle);
  }
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
  if (handle->state != SCR_NATIVE_HANDLE_LIVE) {
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
