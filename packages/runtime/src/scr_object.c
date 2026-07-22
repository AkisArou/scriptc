/* Class instances are per-class C structs emitted by the compiler; the
 * runtime only provides the RC-audit hooks their emitted new/release
 * helpers call — plus the class-OBJECT entry points (classes as values:
 * every class object is an emitted immortal static, so the adapters are
 * no-ops behind the uniform container RC machinery). */
#include "scr_runtime.h"

void *scr_classobj_retain_v(void *c) {
  return scr_classobj_retain((ScrClassObj *)c);
}
void scr_classobj_release_v(void *c) { scr_classobj_release((ScrClassObj *)c); }

ScrStr *scr_classobj_name(ScrClassObj *c) {
  return scr_str_retain((ScrStr *)c->name);
}

#ifdef SCR_RC_AUDIT
static long scr_live_objects = 0;
long scr_obj_live_count(void) { return scr_live_objects; }
void scr_obj_alloc_note(void) { scr_live_objects++; }
void scr_obj_free_note(void) { scr_live_objects--; }
#else
void scr_obj_alloc_note(void) {}
void scr_obj_free_note(void) {}
#endif
