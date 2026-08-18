/* Owner-side retained callback table.
 *
 * Entries are owner-only; transport tokens carry immutable slot/generation
 * identity to foreign callbacks and never expose an anchor pointer. The table
 * owns an anchor while staging and while closing leases drain. An associated
 * native lifecycle owns it otherwise, leaving only a checked weak lookup here. */
#include "scr_runtime.h"

#include <stdlib.h>

typedef struct {
  uint64_t generation;
  const void *signature;
  void *anchor;
  void *source_context;
  ScrCallbackToken *token;
  bool retired;
  bool owner_claimed;
  bool anchor_owned;
} ScrCallbackTableEntry;

struct ScrCallbackTable {
  ScrOwnerGateway *gateway;
  ScrCallbackAnchorRetainFn retain_anchor;
  ScrCallbackAnchorReleaseFn release_anchor;
  ScrCallbackTableEntry *entries;
  size_t length;
  size_t capacity;
  size_t active;
  bool collecting;
};

ScrCallbackTable *scr_callback_table_new(
    ScrOwnerGateway *gateway, ScrCallbackAnchorRetainFn retain_anchor,
    ScrCallbackAnchorReleaseFn release_anchor) {
  if (gateway == NULL || retain_anchor == NULL || release_anchor == NULL) {
    return NULL;
  }
  ScrCallbackTable *table = calloc(1, sizeof *table);
  if (table == NULL) return NULL;
  table->gateway = gateway;
  table->retain_anchor = retain_anchor;
  table->release_anchor = release_anchor;
  return table;
}

static bool scr_callback_table_reserve(ScrCallbackTable *table) {
  if (table->length < table->capacity) return true;
  size_t capacity = table->capacity == 0 ? 8 : table->capacity * 2;
  if (capacity < table->capacity || capacity > SIZE_MAX / sizeof *table->entries) {
    return false;
  }
  ScrCallbackTableEntry *entries =
      realloc(table->entries, capacity * sizeof *entries);
  if (entries == NULL) return false;
  for (size_t i = table->capacity; i < capacity; i++) {
    entries[i] = (ScrCallbackTableEntry){0};
  }
  table->entries = entries;
  table->capacity = capacity;
  return true;
}

ScrCallbackToken *scr_callback_table_register(ScrCallbackTable *table,
                                               void *anchor,
                                               const void *signature) {
  if (table == NULL || anchor == NULL || signature == NULL ||
      scr_owner_gateway_state(table->gateway) != SCR_OWNER_GATEWAY_RUNNING) {
    return NULL;
  }
  size_t slot = 0;
  while (slot < table->length &&
         (table->entries[slot].token != NULL || table->entries[slot].retired)) {
    slot++;
  }
  if (slot == table->length) {
    if (!scr_callback_table_reserve(table)) return NULL;
    table->length++;
  }
  ScrCallbackTableEntry *entry = &table->entries[slot];
  uint64_t generation = entry->generation == 0 ? 1 : entry->generation;
  ScrCallbackToken *token = scr_callback_token_new(
      table->gateway, table, slot, generation, signature);
  if (token == NULL) return NULL;
  entry->generation = generation;
  entry->signature = signature;
  entry->anchor = anchor;
  entry->token = token;
  entry->anchor_owned = true;
  table->active++;
  return token;
}

void *scr_callback_table_acquire(ScrCallbackTable *table, size_t slot,
                                 uint64_t generation,
                                 const void *signature) {
  if (table == NULL || slot >= table->length) return NULL;
  ScrCallbackTableEntry *entry = &table->entries[slot];
  if (entry->token == NULL || entry->generation != generation ||
      entry->signature != signature || entry->anchor == NULL) {
    return NULL;
  }
  return table->retain_anchor(entry->anchor);
}

/* The token of a live registration whose anchor is this value and which no
 * owner has claimed — the lookup a release-by-value performs.
 *
 * Registrations are NOT deduplicated by anchor: registering one closure twice
 * makes two registrations, and a release retires one of them. So the first
 * match wins, and which one it is cannot matter — they are interchangeable by
 * construction, holding the same anchor and the same signature.
 *
 * An owner-claimed entry is skipped on purpose. A registration a handle owns
 * is ended by that handle's disposal, and letting a value release it would be
 * a second way to end one life. */
ScrCallbackToken *scr_callback_table_find_anchor(ScrCallbackTable *table,
                                                 void *anchor) {
  if (table == NULL || anchor == NULL) return NULL;
  for (size_t slot = 0; slot < table->length; slot++) {
    ScrCallbackTableEntry *entry = &table->entries[slot];
    if (entry->token == NULL || entry->retired || entry->owner_claimed) continue;
    if (entry->anchor != anchor || entry->source_context != NULL) continue;
    if (scr_callback_token_state(entry->token) != SCR_CALLBACK_TOKEN_ACTIVE) {
      continue;
    }
    return entry->token;
  }
  return NULL;
}

static ScrCallbackTableEntry *scr_callback_table_entry(
    ScrCallbackTable *table, ScrCallbackToken *token) {
  if (table == NULL || token == NULL ||
      scr_callback_token_owner_context(token) != table) {
    return NULL;
  }
  size_t slot = scr_callback_token_slot(token);
  if (slot >= table->length) return NULL;
  ScrCallbackTableEntry *entry = &table->entries[slot];
  if (entry->token != token ||
      entry->generation != scr_callback_token_generation(token)) {
    return NULL;
  }
  return entry;
}

bool scr_callback_table_set_source_context(ScrCallbackTable *table,
                                           ScrCallbackToken *token,
                                           void *source_context) {
  ScrCallbackTableEntry *entry = scr_callback_table_entry(table, token);
  if (entry == NULL || entry->source_context != NULL ||
      source_context == NULL) {
    return false;
  }
  entry->source_context = source_context;
  return true;
}

void *scr_callback_table_source_context(ScrCallbackTable *table,
                                        ScrCallbackToken *token) {
  ScrCallbackTableEntry *entry = scr_callback_table_entry(table, token);
  return entry == NULL ? NULL : entry->source_context;
}

bool scr_callback_table_begin_close(ScrCallbackTable *table,
                                    ScrCallbackToken *token) {
  if (scr_callback_table_entry(table, token) == NULL) return false;
  return scr_callback_token_begin_close(token);
}

bool scr_callback_table_begin_discard(ScrCallbackTable *table,
                                      ScrCallbackToken *token) {
  if (scr_callback_table_entry(table, token) == NULL) return false;
  return scr_callback_token_begin_discard(token);
}

bool scr_callback_table_abandon(ScrCallbackTable *table,
                                ScrCallbackToken *token) {
  if (scr_callback_table_entry(table, token) == NULL) return false;
  return scr_callback_token_abandon(token);
}

bool scr_callback_table_cancellation_complete(ScrCallbackTable *table,
                                              ScrCallbackToken *token) {
  if (scr_callback_table_entry(table, token) == NULL) return false;
  return scr_callback_token_cancellation_complete(token);
}

bool scr_callback_table_claim_owner(ScrCallbackTable *table,
                                    ScrCallbackToken *token) {
  ScrCallbackTableEntry *entry = scr_callback_table_entry(table, token);
  if (entry == NULL || entry->owner_claimed ||
      scr_callback_token_state(token) != SCR_CALLBACK_TOKEN_ACTIVE) {
    return false;
  }
  entry->owner_claimed = true;
  return true;
}

void *scr_callback_table_transfer_anchor(ScrCallbackTable *table,
                                         ScrCallbackToken *token) {
  ScrCallbackTableEntry *entry = scr_callback_table_entry(table, token);
  if (entry == NULL || entry->owner_claimed || !entry->anchor_owned ||
      entry->anchor == NULL) {
    return NULL;
  }
  entry->anchor_owned = false;
  return entry->anchor;
}

bool scr_callback_table_adopt_anchor(ScrCallbackTable *table,
                                     ScrCallbackToken *token, void *anchor) {
  ScrCallbackTableEntry *entry = scr_callback_table_entry(table, token);
  if (entry == NULL || entry->anchor_owned || entry->anchor != anchor ||
      anchor == NULL) {
    return false;
  }
  entry->anchor_owned = true;
  return true;
}

bool scr_callback_table_clear_anchor(ScrCallbackTable *table,
                                     ScrCallbackToken *token, void *anchor) {
  ScrCallbackTableEntry *entry = scr_callback_table_entry(table, token);
  if (entry == NULL || entry->anchor_owned || entry->anchor != anchor ||
      anchor == NULL) {
    return false;
  }
  entry->anchor = NULL;
  return true;
}

void scr_callback_table_release_transferred_anchor(ScrCallbackTable *table,
                                                   void *anchor) {
  if (table == NULL || anchor == NULL) {
    scr_trap("scriptc: invalid transferred callback anchor release\n");
  }
  table->release_anchor(anchor);
}

size_t scr_callback_table_collect(ScrCallbackTable *table) {
  if (table == NULL || table->collecting) return 0;
  table->collecting = true;
  size_t collected = 0;
  for (size_t i = 0; i < table->length; i++) {
    ScrCallbackTableEntry *entry = &table->entries[i];
    if (entry->token == NULL ||
        !scr_callback_token_try_destroy(entry->token)) {
      continue;
    }
    /* Unlink before releasing: anchor teardown may re-enter registration. */
    void *anchor = entry->anchor;
    bool anchor_owned = entry->anchor_owned;
    entry->token = NULL;
    entry->anchor = NULL;
    entry->source_context = NULL;
    entry->signature = NULL;
    entry->owner_claimed = false;
    entry->anchor_owned = false;
    if (entry->generation == UINT64_MAX) entry->retired = true;
    else entry->generation++;
    table->active--;
    collected++;
    if (anchor_owned) table->release_anchor(anchor);
  }
  while (table->length != 0 &&
         table->entries[table->length - 1].token == NULL &&
         !table->entries[table->length - 1].retired) {
    table->length--;
  }
  table->collecting = false;
  return collected;
}

size_t scr_callback_table_active(ScrCallbackTable *table) {
  return table == NULL ? 0 : table->active;
}

bool scr_callback_table_destroy(ScrCallbackTable *table) {
  if (table == NULL) return true;
  if (table->active != 0 || table->collecting ||
      !scr_owner_gateway_quiescent(table->gateway)) {
    return false;
  }
  free(table->entries);
  free(table);
  return true;
}
