/* Per-instance retained native callback service.
 *
 * The gateway and table are owner-thread state. Their heap allocations remain
 * reachable by transport tokens on foreign producer threads, while SCR_TL
 * ensures a thread-instanced library gets one independent owner service per
 * initialized ScriptC instance. Foreign thunks never access these globals:
 * they only call scr_callback_token_admit with their opaque token. */
#include "scr_runtime.h"

static SCR_TL ScrOwnerGateway *scr_retained_gateway;
static SCR_TL ScrCallbackTable *scr_retained_table;
static SCR_TL bool scr_retained_accepting;

static void *scr_retained_closure_retain(void *opaque) {
  return scr_closure_retain((ScrClosure *)opaque);
}

static void scr_retained_closure_release(void *opaque) {
  scr_closure_release((ScrClosure *)opaque);
}

bool scr_retained_callbacks_configure(ScrOwnerGatewayWakeFn wake,
                                      void *wake_context) {
  if (scr_retained_gateway != NULL || scr_retained_table != NULL) return false;
  ScrOwnerGateway *gateway = scr_owner_gateway_new(wake, wake_context);
  if (gateway == NULL) return false;
  ScrCallbackTable *table = scr_callback_table_new(
      gateway, scr_retained_closure_retain, scr_retained_closure_release);
  if (table == NULL) {
    scr_owner_gateway_stop_accepting(gateway);
    (void)scr_owner_gateway_destroy(gateway);
    return false;
  }
  scr_retained_gateway = gateway;
  scr_retained_table = table;
  scr_retained_accepting = true;
  return true;
}

bool scr_retained_callbacks_configured(void) {
  return scr_retained_gateway != NULL && scr_retained_table != NULL;
}

ScrCallbackToken *scr_retained_callbacks_register(
    ScrClosure *closure, const void *signature, ScrNativeHandle *source_owner) {
  if (!scr_retained_accepting || scr_retained_table == NULL) {
    scr_trap("scriptc: retained callback service is not configured or is shutting down\n");
  }
  if (closure == NULL || signature == NULL) {
    scr_trap("scriptc: invalid retained callback registration metadata\n");
  }
  /* The table's register operation takes ownership only on success. Retain
   * first so this public operation borrows the compiler-owned argument. */
  ScrClosure *root = scr_closure_retain(closure);
  ScrCallbackToken *token =
      scr_callback_table_register(scr_retained_table, root, signature);
  if (token == NULL) {
    scr_closure_release(root);
    scr_trap("scriptc: out of memory registering retained callback\n");
  }
  if (source_owner != NULL &&
      !scr_callback_table_set_source_context(
          scr_retained_table, token, source_owner)) {
    scr_trap("scriptc: failed to associate retained callback source owner\n");
  }
  return token;
}

ScrNativeHandle *scr_retained_callbacks_retain_owner(ScrCallbackToken *token) {
  if (scr_retained_table == NULL || token == NULL) {
    scr_trap("scriptc: retained callback source owner service is unavailable\n");
  }
  ScrNativeHandle *owner = scr_callback_table_source_context(
      scr_retained_table, token);
  if (owner == NULL) {
    scr_trap("scriptc: retained callback has no source owner\n");
  }
  return scr_native_handle_retain_live(owner);
}

void scr_retained_callbacks_prepare(ScrNativeHandle *handle,
                                    ScrCallbackToken *token) {
  if (scr_retained_table == NULL) {
    scr_trap("scriptc: retained callback service is not configured\n");
  }
  scr_native_handle_prepare_callback(handle, scr_retained_table, token);
}

bool scr_retained_callbacks_pending(void) {
  return scr_owner_gateway_pending(scr_retained_gateway);
}

ScrRetainedCallbackDispatch scr_retained_callbacks_dispatch(void) {
  if (scr_retained_gateway == NULL) {
    return SCR_RETAINED_CALLBACK_DISPATCH_IDLE;
  }
  if (scr_exc_pending()) {
    return SCR_RETAINED_CALLBACK_DISPATCH_EXCEPTION;
  }
  if (scr_owner_gateway_take_failure(scr_retained_gateway) ==
      SCR_OWNER_GATEWAY_FAILURE_OOM) {
    scr_trap("scriptc: out of memory in retained callback transport\n");
  }
  size_t delivered = scr_owner_gateway_drain(scr_retained_gateway, 1);
  if (scr_owner_gateway_take_failure(scr_retained_gateway) ==
      SCR_OWNER_GATEWAY_FAILURE_OOM) {
    scr_trap("scriptc: out of memory in retained callback transport\n");
  }
  (void)scr_callback_table_collect(scr_retained_table);
  if (scr_exc_pending()) {
    return SCR_RETAINED_CALLBACK_DISPATCH_EXCEPTION;
  }
  return delivered == 0 ? SCR_RETAINED_CALLBACK_DISPATCH_IDLE
                        : SCR_RETAINED_CALLBACK_DISPATCH_DELIVERED;
}

size_t scr_retained_callbacks_active(void) {
  return scr_callback_table_active(scr_retained_table);
}

void scr_retained_callbacks_stop_accepting(void) {
  if (scr_retained_gateway == NULL && scr_retained_table == NULL) return;
  if (scr_retained_gateway == NULL || scr_retained_table == NULL) {
    scr_trap("scriptc: invalid retained callback service state\n");
  }
  scr_retained_accepting = false;
  scr_owner_gateway_stop_accepting(scr_retained_gateway);
}

size_t scr_retained_callbacks_discard(void) {
  if (scr_retained_gateway == NULL) return 0;
  scr_retained_callbacks_stop_accepting();
  size_t discarded = scr_owner_gateway_discard(scr_retained_gateway);
  (void)scr_callback_table_collect(scr_retained_table);
  return discarded;
}

bool scr_retained_callbacks_destroy(void) {
  if (scr_retained_gateway == NULL && scr_retained_table == NULL) return true;
  if (scr_retained_gateway == NULL || scr_retained_table == NULL) {
    scr_trap("scriptc: invalid retained callback service state\n");
  }
  if (scr_retained_accepting) return false;
  (void)scr_callback_table_collect(scr_retained_table);
  if (scr_callback_table_active(scr_retained_table) != 0 ||
      !scr_owner_gateway_quiescent(scr_retained_gateway)) {
    return false;
  }
  if (!scr_callback_table_destroy(scr_retained_table)) return false;
  if (!scr_owner_gateway_destroy(scr_retained_gateway)) {
    scr_trap("scriptc: retained callback gateway destruction invariant\n");
  }
  scr_retained_table = NULL;
  scr_retained_gateway = NULL;
  scr_retained_accepting = false;
  return true;
}
