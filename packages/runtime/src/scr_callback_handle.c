/* Native-handle callback cancellation edge.
 *
 * The registration is staged before the native factory call so its token can
 * be passed as callback context. Once the result handle exists, this edge
 * owns the closure, orders token close before the foreign destructor, and
 * completes cancellation after that destructor guarantees callback quiescence.
 * A traceable result makes the closure edge visible to cycle collection. */
#include "scr_runtime.h"

#include <stdlib.h>

typedef struct {
  ScrCallbackTable *table;
  ScrCallbackToken *token;
  void *anchor;
} ScrCallbackHandleEdge;

static void scr_callback_handle_begin(void *opaque) {
  ScrCallbackHandleEdge *edge = opaque;
  if (!scr_callback_table_begin_close(edge->table, edge->token)) {
    scr_trap("scriptc: callback owner edge could not begin close\n");
  }
}

static void scr_callback_handle_commit(void *opaque) {
  ScrCallbackHandleEdge *edge = opaque;
  if (!scr_callback_table_claim_owner(edge->table, edge->token)) {
    scr_trap("scriptc: callback registration already has an owner\n");
  }
}

static void scr_callback_handle_abandon(void *opaque) {
  ScrCallbackHandleEdge *edge = opaque;
  if (!scr_callback_table_abandon(edge->table, edge->token)) {
    scr_trap("scriptc: staged callback registration could not be abandoned\n");
  }
  if (!scr_callback_table_clear_anchor(edge->table, edge->token,
                                       edge->anchor)) {
    scr_trap("scriptc: staged callback anchor could not be cleared\n");
  }
  (void)scr_callback_table_collect(edge->table);
  scr_callback_table_release_transferred_anchor(edge->table, edge->anchor);
  edge->anchor = NULL;
}

static void scr_callback_handle_complete(void *opaque) {
  ScrCallbackHandleEdge *edge = opaque;
  bool has_leases = scr_callback_token_leases(edge->token) != 0;
  if (!scr_callback_table_cancellation_complete(edge->table, edge->token)) {
    scr_trap("scriptc: callback owner edge could not complete cancellation\n");
  }
  if (has_leases) {
    if (!scr_callback_table_adopt_anchor(edge->table, edge->token,
                                         edge->anchor)) {
      scr_trap("scriptc: callback table could not resume anchor ownership\n");
    }
  } else if (!scr_callback_table_clear_anchor(edge->table, edge->token,
                                              edge->anchor)) {
    scr_trap("scriptc: callback owner anchor could not be cleared\n");
  }
  (void)scr_callback_table_collect(edge->table);
  if (!has_leases) {
    scr_callback_table_release_transferred_anchor(edge->table, edge->anchor);
  }
  edge->anchor = NULL;
}

static void scr_callback_handle_trace(void *opaque, ScrTraceVisit visit,
                                      void *visit_context) {
  ScrCallbackHandleEdge *edge = opaque;
  visit(edge->anchor, visit_context);
}

static void scr_callback_handle_collect_begin(void *opaque) {
  ScrCallbackHandleEdge *edge = opaque;
  if (!scr_callback_table_begin_discard(edge->table, edge->token)) {
    scr_trap("scriptc: collected callback owner could not begin discard\n");
  }
}

static void scr_callback_handle_collect_complete(void *opaque) {
  ScrCallbackHandleEdge *edge = opaque;
  if (!scr_callback_table_cancellation_complete(edge->table, edge->token) ||
      !scr_callback_table_clear_anchor(edge->table, edge->token,
                                       edge->anchor)) {
    scr_trap("scriptc: collected callback owner could not complete discard\n");
  }
  (void)scr_callback_table_collect(edge->table);
  /* Trial deletion already accounted for the lifecycle -> anchor edge. */
  edge->anchor = NULL;
}

static void scr_callback_handle_destroy(void *opaque) { free(opaque); }

void scr_native_handle_prepare_callback(ScrNativeHandle *handle,
                                        ScrCallbackTable *table,
                                        ScrCallbackToken *token) {
  ScrCallbackHandleEdge *edge = malloc(sizeof *edge);
  if (edge == NULL) scr_trap("scriptc: out of memory\n");
  edge->table = table;
  edge->token = token;
  edge->anchor = NULL;
  scr_native_handle_prepare_lifecycle(
      handle, edge, scr_callback_handle_commit, scr_callback_handle_abandon,
      scr_callback_handle_begin, scr_callback_handle_complete,
      scr_callback_handle_trace, scr_callback_handle_collect_begin,
      scr_callback_handle_collect_complete,
      scr_callback_handle_destroy);
  edge->anchor = scr_callback_table_transfer_anchor(table, token);
  if (edge->anchor == NULL) {
    scr_trap("scriptc: callback lifecycle could not adopt its anchor\n");
  }
}
