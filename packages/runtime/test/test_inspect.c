/* Oracle test for the util.inspect runtime engine (scr_inspect.c).
 * Reads case lines ("<op>\t<arg-hex>\t<expected-hex>\n" — see
 * gen-inspect-cases.mjs) from argv[1] and asserts byte equality against
 * what Node's util.inspect produced: numbers, the string quoting ladder,
 * the layout engine (driven through scr_insp_dyn over parsed JSON —
 * frames, break length, grid grouping, depth placeholders), and Buffer's
 * hex form. Exit 0 = all pass; prints each mismatch (capped) otherwise. */
#include "../src/scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_FIELD (1 << 16)

static int hex_val(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

static size_t hex_decode(const char *hex, char *out) {
  if (strcmp(hex, "-") == 0) return 0;
  size_t n = strlen(hex);
  if (n % 2 != 0 || n / 2 > MAX_FIELD) return (size_t)-1;
  for (size_t i = 0; i < n; i += 2) {
    int hi = hex_val(hex[i]), lo = hex_val(hex[i + 1]);
    if (hi < 0 || lo < 0) return (size_t)-1;
    out[i / 2] = (char)((hi << 4) | lo);
  }
  return n / 2;
}

static long total = 0, failed = 0;

static void check(const char *op, const char *arg, size_t arg_len, ScrStr *got,
                  const char *expected, size_t expected_len) {
  total++;
  if (got->len == expected_len && memcmp(got->data, expected, expected_len) == 0) return;
  failed++;
  if (failed <= 25) {
    fprintf(stderr, "MISMATCH %s(%.*s)\n  expected=%.*s\n  got=%.*s\n", op, (int)(arg_len > 200 ? 200 : arg_len),
            arg, (int)expected_len, expected, (int)got->len, got->data);
  }
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fputs("usage: test_inspect <cases-file>\n", stderr);
    return 2;
  }
  FILE *f = fopen(argv[1], "r");
  if (!f) {
    perror("fopen");
    return 2;
  }
  static char line[MAX_FIELD * 4 + 64];
  static char argbuf[MAX_FIELD];
  static char expbuf[MAX_FIELD];
  while (fgets(line, sizeof line, f)) {
    size_t linelen = strlen(line);
    while (linelen > 0 && (line[linelen - 1] == '\n' || line[linelen - 1] == '\r')) {
      line[--linelen] = 0;
    }
    if (linelen == 0) continue;
    char *fields[3];
    int nfields = 0;
    char *cursor = line;
    while (nfields < 3) {
      fields[nfields++] = cursor;
      char *tab = strchr(cursor, '\t');
      if (!tab) break;
      *tab = 0;
      cursor = tab + 1;
    }
    if (nfields != 3) {
      fprintf(stderr, "bad line: %s\n", line);
      return 2;
    }
    const char *op = fields[0];
    size_t arg_len = hex_decode(fields[1], argbuf);
    size_t exp_len = hex_decode(fields[2], expbuf);
    if (arg_len == (size_t)-1 || exp_len == (size_t)-1) {
      fprintf(stderr, "bad hex: %s\n", line);
      return 2;
    }

    ScrStr *result = NULL;
    if (strcmp(op, "f64") == 0) {
      argbuf[arg_len] = 0;
      result = scr_insp_f64(strtod(argbuf, NULL));
    } else if (strcmp(op, "str") == 0) {
      ScrStr *s = scr_str_new(argbuf, arg_len);
      result = scr_insp_str(s);
      scr_str_release(s);
    } else if (strcmp(op, "json") == 0) {
      ScrStr *text = scr_str_new(argbuf, arg_len);
      ScrDyn *d = scr_json_parse(text);
      scr_str_release(text);
      if (!d) {
        fprintf(stderr, "json parse failed: %.*s\n", (int)arg_len, argbuf);
        return 2;
      }
      result = scr_insp_dyn(d, 0, 2);
      scr_dyn_release(d);
    } else if (strcmp(op, "buffer") == 0) {
      ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, (double)arg_len);
      memcpy(b->data, argbuf, arg_len);
      result = scr_insp_buffer(b);
      scr_bytes_release(b);
    } else {
      fprintf(stderr, "unknown op: %s\n", op);
      return 2;
    }
    check(op, argbuf, arg_len, result, expbuf, exp_len);
    scr_str_release(result);
  }
  {
    ScrDyn *holes = scr_dyn_new_arr();
    for (size_t i = 0; i < 200; i++) scr_dyn_arr_push_hole(holes);
    ScrStr *result = scr_insp_dyn(holes, 0, 2);
    static const char expected[] = "[ <200 empty items> ]";
    check("holes", "200", 3, result, expected, sizeof expected - 1);
    scr_str_release(result);
    scr_dyn_release(holes);
  }
  {
    ScrDyn *mixed = scr_dyn_new_arr();
    for (size_t i = 0; i < 200; i++) scr_dyn_arr_push_hole(mixed);
    ScrDyn *one = scr_dyn_new_num(1);
    ScrDyn *two = scr_dyn_new_num(2);
    ScrStr *k99 = scr_str_new("99", 2);
    ScrStr *k150 = scr_str_new("150", 3);
    scr_dyn_key_set(mixed, k99, one);
    scr_dyn_key_set(mixed, k150, two);
    ScrStr *result = scr_insp_dyn(mixed, 0, 2);
    static const char expected[] = "[ <99 empty items>, 1, <50 empty items>, 2, <49 empty items> ]";
    check("holes-mixed", "200", 3, result, expected, sizeof expected - 1);
    scr_str_release(result);
    scr_str_release(k99);
    scr_str_release(k150);
    scr_dyn_release(one);
    scr_dyn_release(two);
    scr_dyn_release(mixed);
  }
  {
    ScrDyn *boundary = scr_dyn_new_arr();
    for (size_t i = 0; i < 101; i++) scr_dyn_arr_push_hole(boundary);
    for (size_t i = 1; i < 101; i++) {
      char key[24];
      int key_len = snprintf(key, sizeof key, "%zu", i);
      ScrStr *k = scr_str_new(key, (size_t)key_len);
      ScrDyn *v = scr_dyn_new_num((double)i);
      scr_dyn_key_set(boundary, k, v);
      scr_str_release(k);
      scr_dyn_release(v);
    }
    ScrStr *result = scr_insp_dyn(boundary, 0, 2);
    static const char expected[] =
      "[\n"
      "  <1 empty item>, 1,  2,  3,  4,\n"
      "  5,              6,  7,  8,  9,\n"
      "  10,             11, 12, 13, 14,\n"
      "  15,             16, 17, 18, 19,\n"
      "  20,             21, 22, 23, 24,\n"
      "  25,             26, 27, 28, 29,\n"
      "  30,             31, 32, 33, 34,\n"
      "  35,             36, 37, 38, 39,\n"
      "  40,             41, 42, 43, 44,\n"
      "  45,             46, 47, 48, 49,\n"
      "  50,             51, 52, 53, 54,\n"
      "  55,             56, 57, 58, 59,\n"
      "  60,             61, 62, 63, 64,\n"
      "  65,             66, 67, 68, 69,\n"
      "  70,             71, 72, 73, 74,\n"
      "  75,             76, 77, 78, 79,\n"
      "  80,             81, 82, 83, 84,\n"
      "  85,             86, 87, 88, 89,\n"
      "  90,             91, 92, 93, 94,\n"
      "  95,             96, 97, 98, 99,\n"
      "  ... 1 more item\n"
      "]";
    check("holes-boundary", "101", 3, result, expected, sizeof expected - 1);
    scr_str_release(result);
    scr_dyn_release(boundary);
  }
  fclose(f);
  fprintf(stderr, "%ld/%ld cases passed\n", total - failed, total);
  return failed ? 1 : 0;
}
