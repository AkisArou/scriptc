/* Owner-side retained callback table.
 *
 * The table is an explicit root set for active native registrations. Its
 * entries are owner-only; transport tokens carry immutable slot/generation
 * identity to foreign callbacks and never expose an anchor pointer. */
#include "scr_runtime.h"

#include <stdlib.h>

typedef struct {
  uint64_t generation;
  const void *signature;
  void *anchor;
  ScrCallbackToken *token;
  bool retired;
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
  table->active++;
  return token;
}

void *scr_callback_table_acquire(ScrCallbackTable *table, size_t slot,
                                 uint64_t generation,
                                 const void *signature) {
  if (table == NULL || slot >= table->length) return NULL;
  ScrCallbackTableEntry *entry = &table->entries[slot];
  if (entry->token == NULL || entry->generation != generation ||
      entry->signature != signature) {
    return NULL;
  }
  return table->retain_anchor(entry->anchor);
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

bool scr_callback_table_begin_close(ScrCallbackTable *table,
                                    ScrCallbackToken *token) {
  if (scr_callback_table_entry(table, token) == NULL) return false;
  return scr_callback_token_begin_close(token);
}

bool scr_callback_table_cancellation_complete(ScrCallbackTable *table,
                                              ScrCallbackToken *token) {
  if (scr_callback_table_entry(table, token) == NULL) return false;
  return scr_callback_token_cancellation_complete(token);
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
    entry->token = NULL;
    entry->anchor = NULL;
    entry->signature = NULL;
    if (entry->generation == UINT64_MAX) entry->retired = true;
    else entry->generation++;
    table->active--;
    collected++;
    table->release_anchor(anchor);
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
      scr_owner_gateway_state(table->gateway) != SCR_OWNER_GATEWAY_STOPPED ||
      scr_owner_gateway_pending(table->gateway)) {
    return false;
  }
  free(table->entries);
  free(table);
  return true;
}
