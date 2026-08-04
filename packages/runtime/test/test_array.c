/* Unit tests for the array runtime (scr_array.c). Built with ASan +
 * -DSCR_RC_AUDIT by array.test.ts, which also asserts the trap modes abort:
 *
 *   (no args)          run all assertions; prints "N/N cases passed"
 *   --crash-get-oob    read past the end        → RangeError + abort()
 *   --crash-get-frac   read a fractional index  → RangeError + abort()
 *   --crash-set-max    write at 2^32-1          → RangeError + abort()
 *   --crash-pop-empty  pop an empty array       → RangeError + abort()
 *   --crash-copy-hole  densify a scalar hole    → TypeError + abort()
 *
 * The RC-recursion cases (array of strings, array of arrays of strings)
 * assert live counts directly: releasing the outer array must release
 * every reachable element exactly once.
 */
#include "../src/scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef SCR_RC_AUDIT
long scr_str_live_count(void); /* provided by scr_string.c */
long scr_arr_live_count(void); /* provided by scr_array.c */
#endif

static long total = 0, failed = 0;

static void check(bool ok, const char *what) {
  total++;
  if (!ok) {
    failed++;
    fprintf(stderr, "FAIL: %s\n", what);
  }
}

static void check_f64(double got, double want, const char *what) {
  check(got == want, what);
  if (got != want) fprintf(stderr, "  got %g want %g\n", got, want);
}

static void test_f64_basics(void) {
  ScrArr *a = scr_arr_new(SCR_ELEM_F64, 0);
  check_f64(scr_arr_len(a), 0, "new array is empty");
  check_f64(scr_arr_push_f64(a, 1.5), 1, "push returns new length");
  check_f64(scr_arr_push_f64(a, -0.0), 2, "push returns new length (2)");
  check_f64(scr_arr_get_f64(a, 0), 1.5, "get_f64[0]");
  check(scr_arr_get_f64(a, 1) == 0 && signbit(scr_arr_get_f64(a, 1)),
        "-0 round-trips through a slot");
  scr_arr_set_f64(a, 0, 7);
  check_f64(scr_arr_get_f64(a, 0), 7, "set_f64 replaces");
  scr_arr_set_f64(a, 2, 9); /* i == len appends */
  check_f64(scr_arr_len(a), 3, "set at len appends");
  check_f64(scr_arr_get_f64(a, 2), 9, "appended value readable");
  check_f64(scr_arr_pop_f64(a), 9, "pop returns last");
  check_f64(scr_arr_len(a), 2, "pop shrinks");
  /* NaN round-trips bit-exactly through the uint64_t slot. */
  scr_arr_push_f64(a, 0.0 / 0.0);
  check(scr_arr_get_f64(a, 2) != scr_arr_get_f64(a, 2), "NaN round-trips");
  /* growth across many appends */
  for (double i = 0; i < 1000; i++) scr_arr_push_f64(a, i);
  check_f64(scr_arr_len(a), 1003, "1000 pushes grow");
  check_f64(scr_arr_get_f64(a, 1002), 999, "last survives growth");
  check_f64(scr_arr_get_f64(a, 0), 7, "first survives growth");
  scr_arr_release(a);
}

static void test_bool(void) {
  ScrArr *a = scr_arr_new(SCR_ELEM_BOOL, 2);
  scr_arr_push_bool(a, true);
  scr_arr_push_bool(a, false);
  check(scr_arr_get_bool(a, 0) == true, "get_bool true");
  check(scr_arr_get_bool(a, 1) == false, "get_bool false");
  scr_arr_set_bool(a, 0, false);
  check(scr_arr_get_bool(a, 0) == false, "set_bool replaces");
  check(scr_arr_pop_bool(a) == false, "pop_bool");
  scr_arr_release(a);
}

static void test_str_rc(void) {
#ifdef SCR_RC_AUDIT
  long strings0 = scr_str_live_count();
  long arrays0 = scr_arr_live_count();
#endif
  ScrArr *a = scr_arr_new(SCR_ELEM_STR, 0);
  scr_arr_push_ref(a, scr_str_new("one", 3)); /* ownership moves in */
  scr_arr_push_ref(a, scr_str_new("two", 3));

  /* get_ref returns +1: the array and the caller each own a reference. */
  ScrStr *s = (ScrStr *)scr_arr_get_ref(a, 0);
  check(s->rc == 2, "get_ref retained");
  check(strcmp(s->data, "one") == 0, "get_ref content");
  scr_str_release(s);

  /* set_ref releases the replaced element and owns the new one. */
  scr_arr_set_ref(a, 0, scr_str_new("uno", 3));
  ScrStr *r = (ScrStr *)scr_arr_get_ref(a, 0);
  check(strcmp(r->data, "uno") == 0, "set_ref replaced content");
  scr_str_release(r);

  /* pop_ref transfers ownership out: rc unchanged, array no longer owns. */
  ScrStr *popped = (ScrStr *)scr_arr_pop_ref(a);
  check(popped->rc == 1, "pop_ref transfers ownership");
  check(strcmp(popped->data, "two") == 0, "pop_ref content");
  scr_str_release(popped);

  /* immortal literals in arrays: retain/release must stay no-ops */
  static struct { size_t rc; size_t len; size_t cap; char data[4]; } lit = {SIZE_MAX, 3, 3, "lit"};
  scr_arr_push_ref(a, (ScrStr *)&lit);
  ScrStr *l = (ScrStr *)scr_arr_get_ref(a, 1);
  check(l->rc == SIZE_MAX, "immortal element stays immortal");

  scr_arr_release(a); /* must release "uno" (and skip the literal) */
#ifdef SCR_RC_AUDIT
  check(scr_str_live_count() == strings0, "no strings leaked");
  check(scr_arr_live_count() == arrays0, "no arrays leaked");
#endif
}

static void test_nested_rc(void) {
#ifdef SCR_RC_AUDIT
  long strings0 = scr_str_live_count();
  long arrays0 = scr_arr_live_count();
#endif
  /* [[ "a" ], [ "b", "c" ]] — releasing the outer array must cascade. */
  ScrArr *outer = scr_arr_new(SCR_ELEM_ARR, 0);
  ScrArr *row0 = scr_arr_new(SCR_ELEM_STR, 0);
  scr_arr_push_ref(row0, scr_str_new("a", 1));
  scr_arr_push_ref(outer, row0);
  ScrArr *row1 = scr_arr_new(SCR_ELEM_STR, 0);
  scr_arr_push_ref(row1, scr_str_new("b", 1));
  scr_arr_push_ref(row1, scr_str_new("c", 1));
  scr_arr_push_ref(outer, row1);

  ScrArr *row = (ScrArr *)scr_arr_get_ref(outer, 1);
  check(row->rc == 2, "nested get_ref retained");
  check_f64(scr_arr_len(row), 2, "inner length");
  scr_arr_release(row);

  scr_arr_release(outer);
#ifdef SCR_RC_AUDIT
  check(scr_str_live_count() == strings0, "nested: no strings leaked");
  check(scr_arr_live_count() == arrays0, "nested: no arrays leaked");
#endif
}

static void test_index_of_includes(void) {
  /* f64: indexOf is strict equality (NaN never matches, -0 == 0);
   * includes is SameValueZero (NaN matches NaN). */
  ScrArr *a = scr_arr_new(SCR_ELEM_F64, 0);
  scr_arr_push_f64(a, 1);
  scr_arr_push_f64(a, 0.0 / 0.0);
  scr_arr_push_f64(a, -0.0);
  check_f64(scr_arr_index_of_f64(a, 1), 0, "indexOf f64 hit");
  check_f64(scr_arr_index_of_f64(a, 2), -1, "indexOf f64 miss");
  check_f64(scr_arr_index_of_f64(a, 0.0 / 0.0), -1, "indexOf NaN never matches");
  check(scr_arr_includes_f64(a, 0.0 / 0.0), "includes NaN matches NaN");
  check_f64(scr_arr_index_of_f64(a, 0.0), 2, "indexOf 0 matches -0");
  check(scr_arr_includes_f64(a, 0.0), "includes 0 matches -0");
  check(!scr_arr_includes_f64(a, 5), "includes miss");
  scr_arr_release(a);

  /* bool by value. */
  ScrArr *b = scr_arr_new(SCR_ELEM_BOOL, 0);
  scr_arr_push_bool(b, false);
  scr_arr_push_bool(b, true);
  check_f64(scr_arr_index_of_bool(b, true), 1, "indexOf bool");
  check(scr_arr_includes_bool(b, false), "includes bool");
  scr_arr_release(b);

  /* strings by CONTENT; needle borrowed (rc unchanged, released by us). */
  ScrArr *s = scr_arr_new(SCR_ELEM_STR, 0);
  scr_arr_push_ref(s, scr_str_new("aa", 2));
  scr_arr_push_ref(s, scr_str_new("bb", 2));
  ScrStr *needle = scr_str_new("bb", 2);
  check_f64(scr_arr_index_of_ref(s, needle), 1, "indexOf string by content");
  check(scr_arr_includes_ref(s, needle), "includes string by content");
  check(needle->rc == 1, "indexOf/includes borrow the needle");
  scr_str_release(needle);
  scr_arr_release(s);

  /* nested arrays by reference identity. */
  ScrArr *outer = scr_arr_new(SCR_ELEM_ARR, 0);
  ScrArr *inner = scr_arr_new(SCR_ELEM_F64, 0);
  ScrArr *other = scr_arr_new(SCR_ELEM_F64, 0);
  scr_arr_push_ref(outer, scr_arr_retain(inner));
  check_f64(scr_arr_index_of_ref(outer, inner), 0, "indexOf array by identity");
  check_f64(scr_arr_index_of_ref(outer, other), -1, "structurally-equal array misses");
  scr_arr_release(inner);
  scr_arr_release(other);
  scr_arr_release(outer);

  /* includes performs Get and therefore sees a union-backed hole's stored
   * undefined value; indexOf skips holes per HasProperty. An array pointer
   * stands in for the runtime's immortal undefined singleton here. */
  ScrArr *sparse = scr_arr_new(SCR_ELEM_ARR, 0);
  ScrArr *undefined_fill = scr_arr_new(SCR_ELEM_F64, 0);
  scr_arr_set_sparse_len(sparse, 1, undefined_fill);
  check(scr_arr_includes_ref(sparse, undefined_fill), "includes reads a represented hole");
  check_f64(scr_arr_index_of_ref(sparse, undefined_fill), -1, "indexOf skips a represented hole");
  scr_arr_release(sparse);
  scr_arr_release(undefined_fill);
}

/* ── SCR_ELEM_REF: a mock "record" the runtime cannot lay out ─────────
 * Acyclic flavor: 1-word rc header, retain/release via the stored fn ptrs
 * (the compiler's `_v` adapters stand in). Cyclic flavor: allocated with a
 * collector header whose trace visits an owner ARRAY slot — the record can
 * point back at the array holding it, the REF cycle case. */
typedef struct MockRec {
  size_t rc;
  int value;
  ScrArr *owner; /* cyclic flavor only: traced edge back at an array */
} MockRec;

static long mock_live = 0;

static void *mock_retain(void *p) {
  MockRec *r = (MockRec *)p;
  if (r->rc != SIZE_MAX) r->rc++;
  return r;
}

static void mock_release(void *p) {
  MockRec *r = (MockRec *)p;
  if (!r || r->rc == SIZE_MAX) return;
  if (--r->rc == 0) {
    mock_live--;
    free(r);
  }
}

static MockRec *mock_new(int value) {
  MockRec *r = calloc(1, sizeof *r);
  r->rc = 1;
  r->value = value;
  mock_live++;
  return r;
}

static void mock_trace(void *p, ScrTraceVisit visit, void *ctx) {
  MockRec *r = (MockRec *)p;
  if (r->owner) visit(r->owner, ctx);
}

static void mock_gcfree(void *p) {
  /* trace visits owner (headered); nothing else refcounted to release */
  mock_live--;
  scr_cyc_free(p);
}

static void *mock_cyc_retain(void *p) {
  MockRec *r = (MockRec *)p;
  if (r->rc != SIZE_MAX) {
    r->rc++;
    scr_cyc_mark_live(r);
  }
  return r;
}

static void mock_cyc_release(void *p) {
  MockRec *r = (MockRec *)p;
  if (!r || r->rc == SIZE_MAX) return;
  if (--r->rc == 0) {
    scr_cyc_on_dead(r);
    if (r->owner) scr_arr_release(r->owner);
    mock_live--;
    scr_cyc_free(r);
  } else {
    scr_cyc_on_release(r);
  }
}

static MockRec *mock_cyc_new(int value) {
  MockRec *r = scr_cyc_alloc(sizeof *r, &mock_trace, &mock_gcfree);
  r->rc = 1;
  r->value = value;
  mock_live++;
  return r;
}

static void test_ref_elements(void) {
#ifdef SCR_RC_AUDIT
  long arrays0 = scr_arr_live_count();
#endif
  ScrArr *a = scr_arr_new_ref(&mock_retain, &mock_release, NULL, 0);
  scr_arr_push_ref(a, mock_new(1)); /* ownership moves in */
  scr_arr_push_ref(a, mock_new(2));
  check_f64(scr_arr_len(a), 2, "ref push grows");

  /* get_ref retains through the stored fn ptr. */
  MockRec *r = (MockRec *)scr_arr_get_ref(a, 0);
  check(r->rc == 2, "ref get_ref retained via elem_retain");
  check(r->value == 1, "ref get_ref content");
  mock_release(r);

  /* set_ref releases the replaced element through elem_release. */
  scr_arr_set_ref(a, 0, mock_new(10));
  check(mock_live == 2, "ref set_ref released the old element");
  MockRec *rr = (MockRec *)scr_arr_get_ref(a, 0);
  check(rr->value == 10, "ref set_ref replaced content");
  mock_release(rr);

  /* indexOf/includes: POINTER identity, needle borrowed. */
  MockRec *second = (MockRec *)scr_arr_get_ref(a, 1);
  check_f64(scr_arr_index_of_ref(a, second), 1, "ref indexOf by identity");
  check(scr_arr_includes_ref(a, second), "ref includes by identity");
  MockRec *stranger = mock_new(2);
  check_f64(scr_arr_index_of_ref(a, stranger), -1, "ref equal-value stranger misses");
  check(second->rc == 2, "ref indexOf borrows the needle");
  mock_release(stranger);

  /* pop_ref transfers ownership out. */
  MockRec *popped = (MockRec *)scr_arr_pop_ref(a);
  check(popped == second, "ref pop_ref returns the element");
  check(popped->rc == 2, "ref pop_ref transfers (our get_ref + the pop)");
  mock_release(popped);
  mock_release(second);

  scr_arr_release(a); /* releases the remaining element */
  check(mock_live == 0, "ref elements all released");
#ifdef SCR_RC_AUDIT
  check(scr_arr_live_count() == arrays0, "ref: no arrays leaked");
#endif
}

static void test_ref_cycle(void) {
#ifdef SCR_RC_AUDIT
  long arrays0 = scr_arr_live_count();
#endif
  /* arr -> rec -> arr: drop the external references, then collect. */
  ScrArr *arr = scr_arr_new_ref(&mock_cyc_retain, &mock_cyc_release, &mock_trace, 0);
  MockRec *rec = mock_cyc_new(7);
  rec->owner = (ScrArr *)scr_arr_retain(arr); /* rec points back at arr */
  scr_arr_push_ref(arr, rec);                 /* arr owns rec */
  check(mock_live == 1, "cycle: element alive");
  scr_arr_release(arr); /* external edge gone; the cycle keeps both alive */
  scr_collect_cycles();
  check(mock_live == 0, "cycle collected through the array element");

  arr = scr_arr_new_ref(&mock_cyc_retain, &mock_cyc_release, &mock_trace, 0);
  rec = mock_cyc_new(8);
  rec->owner = (ScrArr *)scr_arr_retain(arr);
  scr_arr_push_ref(arr, rec);
  scr_arr_delete(arr, 0, NULL);
  check(mock_live == 0, "cycle: delete unlinks before releasing element");
  scr_arr_release(arr);

  arr = scr_arr_new_ref(&mock_cyc_retain, &mock_cyc_release, &mock_trace, 0);
  rec = mock_cyc_new(9);
  rec->owner = (ScrArr *)scr_arr_retain(arr);
  scr_arr_push_ref(arr, rec);
  scr_arr_set_sparse_len(arr, 0, NULL);
  check(mock_live == 0, "cycle: truncation unlinks before releasing element");
  scr_arr_release(arr);
#ifdef SCR_RC_AUDIT
  check(scr_arr_live_count() == arrays0, "cycle: no arrays leaked");
#endif
}

static void test_join(void) {
#ifdef SCR_RC_AUDIT
  long strings0 = scr_str_live_count();
#endif
  ScrStr *sep = scr_str_new(",", 1);

  ScrArr *n = scr_arr_new(SCR_ELEM_F64, 0);
  ScrStr *empty = scr_arr_join(n, sep);
  check(empty->len == 0, "join of empty array is \"\"");
  scr_str_release(empty);
  scr_arr_push_f64(n, 1.5);
  scr_arr_push_f64(n, -0.0);
  scr_arr_push_f64(n, 0.0 / 0.0);
  ScrStr *nums = scr_arr_join(n, sep);
  check(strcmp(nums->data, "1.5,0,NaN") == 0, "join f64 (JS formatting, -0 -> \"0\")");
  scr_str_release(nums);
  scr_arr_release(n);

  ScrArr *b = scr_arr_new(SCR_ELEM_BOOL, 0);
  scr_arr_push_bool(b, true);
  scr_arr_push_bool(b, false);
  ScrStr *bools = scr_arr_join(b, sep);
  check(strcmp(bools->data, "true,false") == 0, "join bool");
  scr_str_release(bools);
  scr_arr_release(b);

  ScrArr *s = scr_arr_new(SCR_ELEM_STR, 0);
  scr_arr_push_ref(s, scr_str_new("a", 1));
  scr_arr_push_ref(s, scr_str_new("", 0));
  scr_arr_push_ref(s, scr_str_new("c", 1));
  ScrStr *sep0 = scr_str_new("", 0);
  ScrStr *sepless = scr_arr_join(s, sep0); /* join borrows the separator */
  check(strcmp(sepless->data, "ac") == 0, "join with empty separator");
  scr_str_release(sepless);
  scr_str_release(sep0);
  ScrStr *sep2 = scr_str_new("--", 2);
  ScrStr *strs = scr_arr_join(s, sep2);
  check(strcmp(strs->data, "a----c") == 0, "join strings verbatim, empty kept");
  scr_str_release(strs);
  scr_str_release(sep2);
  scr_arr_release(s);

  scr_str_release(sep);
#ifdef SCR_RC_AUDIT
  check(scr_str_live_count() == strings0, "join: no strings leaked");
#endif
}

static void test_sparse(void) {
#ifdef SCR_RC_AUDIT
  long strings0 = scr_str_live_count();
  long arrays0 = scr_arr_live_count();
#endif
  ScrArr *a = scr_arr_new(SCR_ELEM_STR, 0);
  check(a->present == NULL, "packed arrays have no presence bitmap");
  scr_arr_set_sparse_len(a, 4, NULL);
  check_f64(scr_arr_len(a), 4, "sparse allocation sets length");
  check(!scr_arr_has(a, 0) && !scr_arr_has(a, 3), "sparse allocation creates holes");
  scr_arr_set_ref(a, 1, scr_str_new("x", 1));
  scr_arr_set_ref(a, 3, scr_str_new("z", 1));
  check(scr_arr_has(a, 1) && scr_arr_has(a, 3), "indexed writes mark slots present");
  ScrStr *missing = scr_str_new("missing", 7);
  check_f64(scr_arr_index_of_ref(a, missing), -1, "indexOf skips holes");
  scr_str_release(missing);
  ScrStr *sep = scr_str_new(",", 1);
  ScrStr *joined = scr_arr_join(a, sep);
  check(strcmp(joined->data, ",x,,z") == 0, "join renders holes as empty fields");
  scr_str_release(joined);
  scr_str_release(sep);

  ScrArr *slice = scr_arr_slice(a, 1, 4);
  check(scr_arr_has(slice, 0) && !scr_arr_has(slice, 1) && scr_arr_has(slice, 2),
        "slice preserves holes");
  scr_arr_delete(slice, 0, NULL);
  check(!scr_arr_has(slice, 0) && scr_arr_len(slice) == 3,
        "delete clears presence without changing length");
  scr_arr_release(slice);
  scr_arr_release(a);

  ScrArr *far = scr_arr_new(SCR_ELEM_F64, 0);
  scr_arr_push_f64(far, 1);
  scr_arr_set_f64(far, 4, 5);
  check_f64(scr_arr_len(far), 5, "far indexed write grows length");
  check(scr_arr_has(far, 0) && !scr_arr_has(far, 1) &&
            !scr_arr_has(far, 2) && !scr_arr_has(far, 3) &&
            scr_arr_has(far, 4),
        "far indexed write creates intermediate holes");
  check_f64(scr_arr_get_f64(far, 0), 1, "far write preserves prefix");
  check_f64(scr_arr_get_f64(far, 4), 5, "far write stores endpoint");
  scr_arr_set_f64(far, 5, 6);
  check_f64(scr_arr_len(far), 6, "write at sparse length appends");
  check(!scr_arr_has(far, 3) && scr_arr_has(far, 5),
        "sparse append preserves existing holes");
  scr_arr_release(far);

  ScrArr *far_refs = scr_arr_new(SCR_ELEM_STR, 0);
  scr_arr_push_ref(far_refs, scr_str_new("a", 1));
  scr_arr_set_ref(far_refs, 3, scr_str_new("d", 1));
  check_f64(scr_arr_len(far_refs), 4, "far ref write grows length");
  check(!scr_arr_has(far_refs, 1) && !scr_arr_has(far_refs, 2),
        "far ref write leaves unowned holes");
  scr_arr_release(far_refs);

  ScrArr *dst = scr_arr_new(SCR_ELEM_F64, 0);
  ScrArr *src = scr_arr_new(SCR_ELEM_F64, 1);
  scr_arr_push_f64(src, 1);
  dst->len = UINT32_MAX;
  check_f64(scr_arr_append_sparse(dst, src, NULL), UINT32_MAX,
            "sparse append leaves destination unchanged above max length");
  check(scr_exc_pending(), "sparse append above max length throws");
  scr_exc_clear();
  dst->len = 0; /* The synthetic oversized length owns no slots. */
  scr_arr_release(src);
  scr_arr_release(dst);
#ifdef SCR_RC_AUDIT
  check(scr_str_live_count() == strings0, "sparse: no strings leaked");
  check(scr_arr_live_count() == arrays0, "sparse: no arrays leaked");
#endif
}

static void test_copying_holes(void) {
  long live0 = mock_live;
  MockRec *undefined_fill = mock_new(-1);
  ScrArr *src = scr_arr_new_ref(&mock_retain, &mock_release, NULL, 0);
  scr_arr_push_ref(src, mock_new(1));
  scr_arr_set_sparse_len(src, 4, undefined_fill);
  scr_arr_set_ref(src, 2, mock_new(3));

  ScrArr *reversed = scr_arr_to_reversed(src);
  check(reversed->present == NULL, "toReversed densifies represented holes");
  check(scr_arr_has(reversed, 0) && scr_arr_has(reversed, 1) &&
            scr_arr_has(reversed, 2) && scr_arr_has(reversed, 3),
        "toReversed result has every index");
  MockRec *v = scr_arr_get_ref(reversed, 0);
  check(v == undefined_fill, "toReversed reads a hole as undefined backing");
  mock_release(v);
  check(undefined_fill->rc == 3,
        "toReversed retains each densified undefined backing");
  scr_arr_release(reversed);
  check(undefined_fill->rc == 1,
        "toReversed releases densified undefined backings");

  ScrArr *items = scr_arr_new_ref(&mock_retain, &mock_release, NULL, 0);
  scr_arr_push_ref(items, mock_new(2));
  ScrArr *spliced = scr_arr_to_spliced(src, 1, 1, items);
  check(spliced->present == NULL, "toSpliced densifies kept holes");
  check_f64(scr_arr_len(spliced), 4, "toSpliced keeps expected length");
  v = scr_arr_get_ref(spliced, 3);
  check(v == undefined_fill, "toSpliced reads a kept hole as undefined backing");
  mock_release(v);
  check(undefined_fill->rc == 2,
        "toSpliced retains a kept undefined backing");
  scr_arr_release(spliced);
  check(undefined_fill->rc == 1,
        "toSpliced releases a kept undefined backing");

  MockRec *replacement = mock_new(9);
  ScrArr *with = scr_arr_with_ref(src, 0, replacement);
  check(with->present == NULL, "with densifies represented holes");
  check(undefined_fill->rc == 3, "with retains densified undefined backings");
  check(replacement->rc == 2, "with retains the borrowed replacement");
  scr_arr_release(with);
  check(undefined_fill->rc == 1, "with releases densified undefined backings");
  check(replacement->rc == 1, "with releases its replacement reference");
  mock_release(replacement);

  ScrArr *plain = scr_arr_new(SCR_ELEM_F64, 0);
  scr_arr_push_f64(plain, 1);
  scr_arr_set_f64(plain, 2, 3);
  ScrArr *no_items = scr_arr_new(SCR_ELEM_F64, 0);
  ScrArr *deleted = scr_arr_to_spliced(plain, 1, 1, no_items);
  check(deleted->present == NULL && scr_arr_len(deleted) == 2,
        "toSpliced does not Get a deleted unrepresentable hole");
  check_f64(scr_arr_get_f64(deleted, 0), 1, "toSpliced deleted-hole prefix");
  check_f64(scr_arr_get_f64(deleted, 1), 3, "toSpliced deleted-hole suffix");
  ScrArr *replaced = scr_arr_with_f64(plain, 1, 2);
  check(replaced->present == NULL && scr_arr_has(replaced, 1),
        "with does not Get its replaced hole");
  check_f64(scr_arr_get_f64(replaced, 1), 2, "with stores over a scalar hole");
  scr_arr_release(replaced);
  scr_arr_release(deleted);
  scr_arr_release(no_items);
  scr_arr_release(plain);

  scr_arr_release(items);
  scr_arr_release(src);
  mock_release(undefined_fill);
  check(mock_live == live0, "copying methods balance ref elements");
}

int main(int argc, char **argv) {
  if (argc > 1) {
    ScrArr *a = scr_arr_new(SCR_ELEM_F64, 0);
    scr_arr_push_f64(a, 1);
    if (strcmp(argv[1], "--crash-get-oob") == 0) {
      scr_arr_get_f64(a, 1); /* len is 1 */
    } else if (strcmp(argv[1], "--crash-get-frac") == 0) {
      scr_arr_get_f64(a, 0.5);
    } else if (strcmp(argv[1], "--crash-set-max") == 0) {
      scr_arr_set_f64(a, 4294967295.0, 9);
    } else if (strcmp(argv[1], "--crash-pop-empty") == 0) {
      scr_arr_pop_f64(a);
      scr_arr_pop_f64(a); /* now empty */
    } else if (strcmp(argv[1], "--crash-copy-hole") == 0) {
      scr_arr_set_sparse_len(a, 2, NULL);
      ScrArr *copy = scr_arr_to_reversed(a);
      scr_arr_release(copy);
    } else {
      fprintf(stderr, "unknown mode %s\n", argv[1]);
      return 2;
    }
    fprintf(stderr, "expected a trap, still alive\n");
    return 2;
  }

  test_f64_basics();
  test_bool();
  test_str_rc();
  test_nested_rc();
  test_index_of_includes();
  test_ref_elements();
  test_ref_cycle();
  test_copying_holes();
  test_join();
  test_sparse();

  fprintf(stderr, "%ld/%ld cases passed\n", total - failed, total);
  return failed == 0 ? 0 : 1;
}
