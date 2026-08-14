/* Retained native callback transport token.
 *
 * One atomic word linearizes ACTIVE/CLOSING with the invocation lease count.
 * This is deliberately separate from the owner-only callback table: a native
 * thread can validate and enqueue copied bytes without gaining a pointer to a
 * ScriptC closure or participating in its reference-count/cycle graph. */
#include "scr_runtime.h"

#include <limits.h>
#include <stdatomic.h>
#include <stdlib.h>

#define SCR_CALLBACK_STATE_SHIFT (sizeof(uintptr_t) * CHAR_BIT - 2)
#define SCR_CALLBACK_STATE_MASK ((uintptr_t)3 << SCR_CALLBACK_STATE_SHIFT)
#define SCR_CALLBACK_LEASE_MASK (~SCR_CALLBACK_STATE_MASK)
#define SCR_CALLBACK_CLOSING_WORD ((uintptr_t)1 << SCR_CALLBACK_STATE_SHIFT)
#define SCR_CALLBACK_DISPOSED_WORD ((uintptr_t)2 << SCR_CALLBACK_STATE_SHIFT)

struct ScrCallbackToken {
  _Atomic uintptr_t gate;
  ScrOwnerGateway *gateway;
  void *owner_context;
  size_t slot;
  uint64_t generation;
  const void *signature;
  bool cancellation_complete;
};

static ScrCallbackTokenState scr_callback_word_state(uintptr_t word) {
  switch (word & SCR_CALLBACK_STATE_MASK) {
  case 0:
    return SCR_CALLBACK_TOKEN_ACTIVE;
  case SCR_CALLBACK_CLOSING_WORD:
    return SCR_CALLBACK_TOKEN_CLOSING;
  default:
    return SCR_CALLBACK_TOKEN_DISPOSED;
  }
}

ScrCallbackToken *scr_callback_token_new(ScrOwnerGateway *gateway,
                                          void *owner_context,
                                          size_t slot, uint64_t generation,
                                          const void *signature) {
  if (gateway == NULL || owner_context == NULL || generation == 0 ||
      signature == NULL) {
    return NULL;
  }
  ScrCallbackToken *token = calloc(1, sizeof *token);
  if (token == NULL) return NULL;
  atomic_init(&token->gate, 0);
  token->gateway = gateway;
  token->owner_context = owner_context;
  token->slot = slot;
  token->generation = generation;
  token->signature = signature;
  return token;
}

static bool scr_callback_token_acquire(ScrCallbackToken *token) {
  uintptr_t word = atomic_load_explicit(&token->gate, memory_order_acquire);
  for (;;) {
    if ((word & SCR_CALLBACK_STATE_MASK) != 0 ||
        (word & SCR_CALLBACK_LEASE_MASK) == SCR_CALLBACK_LEASE_MASK) {
      return false;
    }
    if (atomic_compare_exchange_weak_explicit(
            &token->gate, &word, word + 1, memory_order_acq_rel,
            memory_order_acquire)) {
      return true;
    }
  }
}

static bool scr_callback_invocation_deliver(ScrOwnerGatewayEvent *base) {
  ScrCallbackInvocation *invocation = (ScrCallbackInvocation *)base;
  ScrCallbackToken *token = invocation->token;
  return invocation->invoke(invocation, token->owner_context, token->slot,
                            token->generation);
}

static void scr_callback_invocation_destroy(ScrOwnerGatewayEvent *base) {
  ScrCallbackInvocation *invocation = (ScrCallbackInvocation *)base;
  ScrCallbackToken *token = invocation->token;
  ScrOwnerGatewayDestroyFn payload_destroy = invocation->payload_destroy;
  /* The payload destructor may inspect or free the containing record. Its
   * lease keeps the token alive across any reentrant owner cleanup. */
  payload_destroy(base);
  (void)atomic_fetch_sub_explicit(&token->gate, 1, memory_order_release);
}

bool scr_callback_token_admit(ScrCallbackToken *token,
                              ScrCallbackInvocation *invocation) {
  if (invocation == NULL) return false;
  /* Generated invocation records always provide invoke/payload_destroy; the
   * callbacks are structural ownership metadata, not fallible user input. */
  if (token == NULL || invocation->signature != token->signature) {
    invocation->payload_destroy(&invocation->event);
    return false;
  }
  if (!scr_callback_token_acquire(token)) {
    invocation->payload_destroy(&invocation->event);
    return false;
  }
  invocation->token = token;
  invocation->event.deliver = scr_callback_invocation_deliver;
  invocation->event.destroy = scr_callback_invocation_destroy;
  return scr_owner_gateway_admit(token->gateway, &invocation->event);
}

bool scr_callback_token_begin_close(ScrCallbackToken *token) {
  if (token == NULL) return false;
  uintptr_t word = atomic_load_explicit(&token->gate, memory_order_acquire);
  for (;;) {
    if ((word & SCR_CALLBACK_STATE_MASK) != 0) return false;
    uintptr_t closing = word | SCR_CALLBACK_CLOSING_WORD;
    if (atomic_compare_exchange_weak_explicit(
            &token->gate, &word, closing, memory_order_acq_rel,
            memory_order_acquire)) {
      return true;
    }
  }
}

bool scr_callback_token_cancellation_complete(ScrCallbackToken *token) {
  if (token == NULL || scr_callback_token_state(token) !=
                           SCR_CALLBACK_TOKEN_CLOSING) {
    return false;
  }
  token->cancellation_complete = true;
  return true;
}

bool scr_callback_token_try_destroy(ScrCallbackToken *token) {
  if (token == NULL) return true;
  if (!token->cancellation_complete) return false;
  uintptr_t expected = SCR_CALLBACK_CLOSING_WORD;
  if (!atomic_compare_exchange_strong_explicit(
          &token->gate, &expected, SCR_CALLBACK_DISPOSED_WORD,
          memory_order_acq_rel, memory_order_acquire)) {
    return false;
  }
  free(token);
  return true;
}

ScrCallbackTokenState scr_callback_token_state(ScrCallbackToken *token) {
  if (token == NULL) return SCR_CALLBACK_TOKEN_DISPOSED;
  return scr_callback_word_state(
      atomic_load_explicit(&token->gate, memory_order_acquire));
}

size_t scr_callback_token_leases(ScrCallbackToken *token) {
  if (token == NULL) return 0;
  uintptr_t word = atomic_load_explicit(&token->gate, memory_order_acquire);
  uintptr_t leases = word & SCR_CALLBACK_LEASE_MASK;
  return (size_t)leases;
}

void *scr_callback_token_owner_context(ScrCallbackToken *token) {
  return token == NULL ? NULL : token->owner_context;
}

size_t scr_callback_token_slot(ScrCallbackToken *token) {
  return token == NULL ? SIZE_MAX : token->slot;
}

uint64_t scr_callback_token_generation(ScrCallbackToken *token) {
  return token == NULL ? 0 : token->generation;
}
