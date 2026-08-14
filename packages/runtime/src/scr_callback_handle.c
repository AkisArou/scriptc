/* Result-owned callback cancellation edge.
 *
 * The registration is staged before the native factory call so its token can
 * be passed as callback context. Once the result handle exists, this edge
 * orders token close before the foreign destructor and cancellation-complete
 * after that destructor has guaranteed callback quiescence. */
#include "scr_runtime.h"

#include <stdlib.h>

typedef struct {
  ScrCallbackTable *table;
  ScrCallbackToken *token;
} ScrCallbackHandleEdge;

static void scr_callback_handle_begin(void *opaque) {
  ScrCallbackHandleEdge *edge = opaque;
  if (!scr_callback_table_begin_close(edge->table, edge->token)) {
    scr_trap("scriptc: callback owner edge could not begin close\n");
  }
}

static void scr_callback_handle_complete(void *opaque) {
  ScrCallbackHandleEdge *edge = opaque;
  if (!scr_callback_table_cancellation_complete(edge->table, edge->token)) {
    scr_trap("scriptc: callback owner edge could not complete cancellation\n");
  }
  (void)scr_callback_table_collect(edge->table);
}

static void scr_callback_handle_destroy(void *opaque) { free(opaque); }

void scr_native_handle_attach_callback(ScrNativeHandle *handle,
                                       ScrCallbackTable *table,
                                       ScrCallbackToken *token) {
  if (!scr_callback_table_claim_owner(table, token)) {
    scr_trap("scriptc: callback registration already has an owner\n");
  }
  ScrCallbackHandleEdge *edge = malloc(sizeof *edge);
  if (edge == NULL) scr_trap("scriptc: out of memory\n");
  edge->table = table;
  edge->token = token;
  scr_native_handle_attach_lifecycle(
      handle, edge, scr_callback_handle_begin, scr_callback_handle_complete,
      scr_callback_handle_destroy);
}
