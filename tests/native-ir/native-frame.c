#include <stddef.h>
#include <stdint.h>

typedef struct NtsCounter NtsCounter;

extern NtsCounter *nts_counter_create(int32_t initial_value);
extern void nts_counter_destroy(NtsCounter *counter);

#ifdef SCR_RC_AUDIT
extern void scr_native_handle_audit_reset(void);
extern size_t scr_native_handle_audit_prepare_count(void);
#endif

static int32_t nts_frame_global_promotions = 0;
static int32_t nts_frame_local_releases = 0;

/* The two mechanics arms of one logical constructor. The stable arm models
 * NewGlobalRef followed by DeleteLocalRef; the frame arm hands the local
 * reference through unchanged and lets its distinct release entry end it.
 * Both use the main fixture's plain allocation so ASan also proves exact
 * teardown. This object links only into the frame-resource observer: tests
 * that do not reach native handles must not acquire an audit dependency. */
NtsCounter *nts_frame_counter_create_stable(int32_t initial_value) {
  NtsCounter *counter = nts_counter_create(initial_value);
  if (counter != NULL) {
    nts_frame_global_promotions++;
    nts_frame_local_releases++;
  }
  return counter;
}

NtsCounter *nts_frame_counter_create_local(int32_t initial_value) {
  return nts_counter_create(initial_value);
}

NtsCounter *nts_frame_counter_create_maybe_stable(int32_t initial_value) {
  if (initial_value < 0) return NULL;
  return nts_frame_counter_create_stable(initial_value);
}

NtsCounter *nts_frame_counter_create_maybe_local(int32_t initial_value) {
  if (initial_value < 0) return NULL;
  return nts_frame_counter_create_local(initial_value);
}

void nts_frame_counter_release_local(NtsCounter *counter) {
  if (counter == NULL) return;
  nts_frame_local_releases++;
  nts_counter_destroy(counter);
}

void nts_frame_resource_reset(void) {
  nts_frame_global_promotions = 0;
  nts_frame_local_releases = 0;
#ifdef SCR_RC_AUDIT
  scr_native_handle_audit_reset();
#endif
}

int32_t nts_frame_global_promotion_count(void) {
  return nts_frame_global_promotions;
}

int32_t nts_frame_local_release_count(void) {
  return nts_frame_local_releases;
}

int32_t nts_frame_managed_cell_count(void) {
#ifdef SCR_RC_AUDIT
  return (int32_t)scr_native_handle_audit_prepare_count();
#else
  return 0;
#endif
}

int32_t nts_frame_expected_managed_cells(int32_t expected) {
#ifdef SCR_RC_AUDIT
  return expected;
#else
  (void)expected;
  return 0;
#endif
}
