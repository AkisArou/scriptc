/* node:util's engine-free static surface. parseArgs crosses the typed
 * frontend through the checked-dynamic tree: the config is JSON-safe data,
 * and the result is the ordinary Node-shaped { values, positionals,
 * tokens? } tree. This keeps the parser independent of every emitted
 * record/union layout while the frontend's dynCheck restores the precise
 * ParsedResults<T> type at the call site.
 *
 * The grammar follows Node 24's util.parseArgs/tokenizeArgs: long options,
 * grouped shorts, inline/separate string values, strict=false unknowns,
 * -- termination, negative booleans, multiple/default accumulation, and
 * token metadata. All input nodes are borrowed; the result owns fresh or
 * retained children. Validation/grammar failures leave a coded TypeError
 * pending and return NULL. */
#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const ScrDyn *pa_member(const ScrDyn *obj, const char *key) {
  if (!obj || obj->kind != SCR_DYN_OBJ) return NULL;
  const ScrDyn *v = scr_dyn_obj_get(obj, key, strlen(key));
  return v && v->kind != SCR_DYN_UNDEF ? v : NULL;
}

static bool pa_str_eq_bytes(const ScrStr *s, const char *p, size_t n) {
  return s && s->len == n && memcmp(s->data, p, n) == 0;
}

static bool pa_str_eq_c(const ScrStr *s, const char *p) {
  return pa_str_eq_bytes(s, p, strlen(p));
}

static ScrStr *pa_str_bytes(const char *p, size_t n) {
  return scr_str_new(p, n);
}

static ScrDyn *pa_dyn_str(const ScrStr *s) {
  return scr_dyn_new_str((ScrStr *)s);
}

static ScrDyn *pa_dyn_str_bytes(const char *p, size_t n) {
  ScrStr *s = pa_str_bytes(p, n);
  ScrDyn *d = pa_dyn_str(s);
  scr_str_release(s);
  return d;
}

static char *pa_path(const char *prefix, const char *name, size_t name_len,
                     const char *suffix) {
  size_t pn = strlen(prefix), sn = strlen(suffix);
  char *out = malloc(pn + name_len + sn + 1);
  if (!out) {
    fputs("scriptc: out of memory\n", stderr);
    abort();
  }
  memcpy(out, prefix, pn);
  memcpy(out + pn, name, name_len);
  memcpy(out + pn + name_len, suffix, sn + 1);
  return out;
}

static void pa_throw_text(ScrJsonBuf *b, const char *code) {
  ScrStr *msg = scr_jb_finish(b);
  scr_throw_error_msg_code(SCR_ERR_TYPE, msg->data, msg->len, code);
  scr_str_release(msg);
}

static void pa_unknown(const ScrStr *raw) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, "Unknown option '");
  scr_jb_put_str(&b, raw);
  scr_jb_puts(&b, "'");
  pa_throw_text(&b, "ERR_PARSE_ARGS_UNKNOWN_OPTION");
}

static void pa_missing_long(const ScrStr *raw) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, "Option '");
  scr_jb_put_str(&b, raw);
  scr_jb_puts(&b, " <value>' argument missing");
  pa_throw_text(&b, "ERR_PARSE_ARGS_INVALID_OPTION_VALUE");
}

static void pa_missing_short(const ScrStr *raw, const ScrStr *name) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, "Option '");
  scr_jb_put_str(&b, raw);
  scr_jb_puts(&b, ", --");
  scr_jb_put_str(&b, name);
  scr_jb_puts(&b, " <value>' argument missing");
  pa_throw_text(&b, "ERR_PARSE_ARGS_INVALID_OPTION_VALUE");
}

static void pa_ambiguous(const ScrStr *raw, const ScrStr *name,
                         bool is_short) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, "Option '");
  scr_jb_put_str(&b, raw);
  scr_jb_puts(&b, "' argument is ambiguous.\nDid you forget to specify the option argument for '");
  scr_jb_put_str(&b, raw);
  scr_jb_puts(&b, "'?\nTo specify an option argument starting with a dash use '--");
  scr_jb_put_str(&b, name);
  scr_jb_puts(&b, "=-XYZ'");
  if (is_short) {
    scr_jb_puts(&b, " or '");
    scr_jb_put_str(&b, raw);
    scr_jb_puts(&b, "-XYZ'");
  }
  scr_jb_puts(&b, ".");
  pa_throw_text(&b, "ERR_PARSE_ARGS_INVALID_OPTION_VALUE");
}

static void pa_takes_no_value(const ScrStr *raw) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, "Option '");
  scr_jb_put_str(&b, raw);
  scr_jb_puts(&b, "' does not take an argument");
  pa_throw_text(&b, "ERR_PARSE_ARGS_INVALID_OPTION_VALUE");
}

static void pa_unexpected(const ScrStr *arg) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, "Unexpected argument '");
  scr_jb_put_str(&b, arg);
  scr_jb_puts(&b, "'. This command does not take positional arguments");
  pa_throw_text(&b, "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL");
}

/* A config boolean with Node's default/validation rule. */
static bool pa_config_bool(const ScrDyn *config, const char *name,
                           bool fallback, bool *ok) {
  const ScrDyn *v = pa_member(config, name);
  if (!v) return fallback;
  if (v->kind == SCR_DYN_BOOL) return v->v.b;
  scr_dyn_arg_type_fail(name, "of type boolean", v);
  *ok = false;
  return fallback;
}

/* Descriptor type: 1 string, 0 boolean, -1 malformed. Descriptors were
 * validated once before parsing, so parsing calls only see 0/1. */
static int pa_desc_type(const ScrDyn *desc) {
  const ScrDyn *v = pa_member(desc, "type");
  if (!v || v->kind != SCR_DYN_STR) return -1;
  if (pa_str_eq_c(v->v.str, "string")) return 1;
  if (pa_str_eq_c(v->v.str, "boolean")) return 0;
  return -1;
}

static bool pa_desc_multiple(const ScrDyn *desc) {
  const ScrDyn *v = pa_member(desc, "multiple");
  return v && v->kind == SCR_DYN_BOOL && v->v.b;
}

static bool pa_default_value_ok(const ScrDyn *v, int type) {
  return type == 1 ? v->kind == SCR_DYN_STR : v->kind == SCR_DYN_BOOL;
}

/* Validate the option schema up front, as Node does even when args is
 * empty. Static TypeScript callers already satisfy this ladder; it keeps
 * JS/unknown crossings catchable and prevents malformed dyn reads. */
static bool pa_validate_options(const ScrDyn *options) {
  if (!options) return true; /* null/undefined mean {} */
  if (options->kind != SCR_DYN_OBJ) {
    scr_dyn_arg_type_fail("options", "of type object", options);
    return false;
  }
  for (size_t i = 0; i < options->v.obj.len; i++) {
    const ScrDynEntry *entry = &options->v.obj.entries[i];
    const ScrDyn *desc = entry->value;
    char *base = pa_path("options.", entry->key, entry->key_len, "");
    if (desc->kind != SCR_DYN_OBJ) {
      scr_dyn_prop_type_fail(base, "of type object", desc);
      free(base);
      return false;
    }
    const ScrDyn *typev = pa_member(desc, "type");
    int type = pa_desc_type(desc);
    if (type < 0) {
      char *path = pa_path(base, "", 0, ".type");
      scr_dyn_prop_type_fail(path, "('string|boolean')",
                             typev ? typev : scr_dyn_undefined());
      free(path);
      free(base);
      return false;
    }
    const ScrDyn *shortv = pa_member(desc, "short");
    if (shortv) {
      char *path = pa_path(base, "", 0, ".short");
      if (shortv->kind != SCR_DYN_STR) {
        scr_dyn_prop_type_fail(path, "of type string", shortv);
        free(path);
        free(base);
        return false;
      }
      if (scr_str_utf16_len(shortv->v.str) != 1) {
        scr_dyn_arg_value_fail(path, "must be a single character", shortv);
        free(path);
        free(base);
        return false;
      }
      free(path);
    }
    const ScrDyn *multiplev = pa_member(desc, "multiple");
    if (multiplev && multiplev->kind != SCR_DYN_BOOL) {
      char *path = pa_path(base, "", 0, ".multiple");
      scr_dyn_prop_type_fail(path, "of type boolean", multiplev);
      free(path);
      free(base);
      return false;
    }
    const ScrDyn *def = pa_member(desc, "default");
    if (def) {
      char *path = pa_path(base, "", 0, ".default");
      if (pa_desc_multiple(desc)) {
        if (def->kind != SCR_DYN_ARR) {
          scr_dyn_prop_type_fail(path, "an instance of Array", def);
          free(path);
          free(base);
          return false;
        }
        for (size_t j = 0; j < def->v.arr.len; j++) {
          if (!pa_default_value_ok(def->v.arr.items[j], type)) {
            char suffix[48];
            snprintf(suffix, sizeof suffix, "[%zu]", j);
            char *item_path = pa_path(path, "", 0, suffix);
            scr_dyn_prop_type_fail(item_path,
                                   type ? "of type string" : "of type boolean",
                                   def->v.arr.items[j]);
            free(item_path);
            free(path);
            free(base);
            return false;
          }
        }
      } else if (!pa_default_value_ok(def, type)) {
        scr_dyn_prop_type_fail(path,
                               type ? "of type string" : "of type boolean", def);
        free(path);
        free(base);
        return false;
      }
      free(path);
    }
    free(base);
  }
  return true;
}

static const ScrDyn *pa_find_long(const ScrDyn *options, const ScrStr *name) {
  if (!options) return NULL;
  return scr_dyn_obj_get(options, name->data, name->len);
}

static const ScrDyn *pa_find_short(const ScrDyn *options, const ScrStr *short_name,
                                   const char **long_name, size_t *long_len) {
  if (!options) return NULL;
  for (size_t i = 0; i < options->v.obj.len; i++) {
    const ScrDynEntry *entry = &options->v.obj.entries[i];
    const ScrDyn *shortv = pa_member(entry->value, "short");
    if (shortv && shortv->kind == SCR_DYN_STR &&
        shortv->v.str->len == short_name->len &&
        memcmp(shortv->v.str->data, short_name->data, short_name->len) == 0) {
      *long_name = entry->key;
      *long_len = entry->key_len;
      return entry->value;
    }
  }
  return NULL;
}

static ScrDyn *pa_option_token(const ScrStr *name, const ScrStr *raw,
                               size_t index, const ScrStr *value, int inline_value) {
  ScrDyn *token = scr_dyn_new_obj();
  scr_dyn_obj_set(token, "kind", 4, pa_dyn_str_bytes("option", 6));
  scr_dyn_obj_set(token, "name", 4, pa_dyn_str(name));
  scr_dyn_obj_set(token, "rawName", 7, pa_dyn_str(raw));
  scr_dyn_obj_set(token, "index", 5, scr_dyn_new_num((double)index));
  scr_dyn_obj_set(token, "value", 5,
                  value ? pa_dyn_str(value) : scr_dyn_retain(scr_dyn_undefined()));
  scr_dyn_obj_set(token, "inlineValue", 11,
                  inline_value < 0 ? scr_dyn_retain(scr_dyn_undefined())
                                   : scr_dyn_new_bool(inline_value != 0));
  return token;
}

static void pa_store(ScrDyn *values, ScrDyn *tokens, const ScrDyn *desc,
                     const ScrStr *name, const ScrStr *raw, size_t index,
                     const ScrStr *value, bool flag_value, int inline_value) {
  ScrDyn *stored = value ? pa_dyn_str(value) : scr_dyn_new_bool(flag_value);
  if (desc && pa_desc_multiple(desc)) {
    ScrDyn *arr = scr_dyn_obj_get(values, name->data, name->len);
    if (!arr) {
      arr = scr_dyn_new_arr();
      scr_dyn_obj_set(values, name->data, name->len, arr);
    }
    scr_dyn_arr_push(arr, stored);
  } else {
    scr_dyn_obj_set(values, name->data, name->len, stored);
  }
  if (tokens) {
    scr_dyn_arr_push(tokens,
                     pa_option_token(name, raw, index, value, inline_value));
  }
}

static void pa_positional(ScrDyn *positionals, ScrDyn *tokens,
                          const ScrStr *value, size_t index) {
  scr_dyn_arr_push(positionals, pa_dyn_str(value));
  if (!tokens) return;
  ScrDyn *token = scr_dyn_new_obj();
  scr_dyn_obj_set(token, "kind", 4, pa_dyn_str_bytes("positional", 10));
  scr_dyn_obj_set(token, "index", 5, scr_dyn_new_num((double)index));
  scr_dyn_obj_set(token, "value", 5, pa_dyn_str(value));
  scr_dyn_arr_push(tokens, token);
}

static ScrDyn *pa_default_args(void) {
  ScrDyn *args = scr_dyn_new_arr();
  int argc = scr_lib_arg_count();
  /* Raw argv[0] is the executable. process.argv's synthetic first two
   * entries occupy it plus "scriptc", so slice(2) begins at raw argv[1]. */
  for (int i = 1; i < argc; i++) {
    const char *arg = scr_lib_arg(i);
    scr_dyn_arr_push(args, pa_dyn_str_bytes(arg, strlen(arg)));
  }
  return args;
}

ScrDyn *scr_util_parse_args(const ScrDyn *config) {
  bool ok = true;
  /* Omitted config is lowered as {}, while an explicit undefined takes the
   * default parameter just as Node does. Null keeps Object(null)'s useful
   * failure; other primitive/array wrappers have no config members. */
  if (!config || config->kind == SCR_DYN_NULL) {
    static const char msg[] = "Cannot convert undefined or null to object";
    scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
    return NULL;
  }
  const ScrDyn *cfg = config->kind == SCR_DYN_OBJ ? config : NULL;
  bool strict = pa_config_bool(cfg, "strict", true, &ok);
  bool allow_positionals = pa_config_bool(cfg, "allowPositionals", !strict, &ok);
  bool allow_negative = pa_config_bool(cfg, "allowNegative", false, &ok);
  bool return_tokens = pa_config_bool(cfg, "tokens", false, &ok);
  if (!ok) return NULL;

  const ScrDyn *options = pa_member(cfg, "options");
  if (options && options->kind == SCR_DYN_NULL) options = NULL;
  if (!pa_validate_options(options)) return NULL;

  ScrDyn *owned_args = NULL;
  const ScrDyn *args = pa_member(cfg, "args");
  if (!args || args->kind == SCR_DYN_NULL) {
    owned_args = pa_default_args();
    args = owned_args;
  } else if (args->kind != SCR_DYN_ARR) {
    scr_dyn_arg_type_fail("args", "an instance of Array", args);
    return NULL;
  }
  for (size_t i = 0; i < args->v.arr.len; i++) {
    if (args->v.arr.items[i]->kind != SCR_DYN_STR) {
      char name[48];
      snprintf(name, sizeof name, "args[%zu]", i);
      scr_dyn_prop_type_fail(name, "of type string", args->v.arr.items[i]);
      scr_dyn_release(owned_args);
      return NULL;
    }
  }

  ScrDyn *result = scr_dyn_new_obj();
  ScrDyn *values = scr_dyn_new_obj_null_proto();
  ScrDyn *positionals = scr_dyn_new_arr();
  ScrDyn *tokens = return_tokens ? scr_dyn_new_arr() : NULL;
  bool after_terminator = false;

  for (size_t i = 0; i < args->v.arr.len; i++) {
    const ScrStr *arg = args->v.arr.items[i]->v.str;
    if (after_terminator) {
      pa_positional(positionals, tokens, arg, i);
      continue;
    }
    if (pa_str_eq_c(arg, "--")) {
      after_terminator = true;
      if (tokens) {
        ScrDyn *token = scr_dyn_new_obj();
        scr_dyn_obj_set(token, "kind", 4,
                        pa_dyn_str_bytes("option-terminator", 17));
        scr_dyn_obj_set(token, "index", 5, scr_dyn_new_num((double)i));
        scr_dyn_arr_push(tokens, token);
      }
      continue;
    }

    if (arg->len >= 2 && arg->data[0] == '-' && arg->data[1] == '-') {
      size_t eq = arg->len;
      /* `--=x` is the option named "=x", not an empty option with an
       * inline value. An equals separator is recognized only after at
       * least one name byte, matching Node's tokenizer. */
      for (size_t j = 3; j < arg->len; j++) {
        if (arg->data[j] == '=') { eq = j; break; }
      }
      ScrStr *name = pa_str_bytes(arg->data + 2, eq - 2);
      ScrStr *raw = pa_str_bytes(arg->data, eq);
      const ScrDyn *desc = pa_find_long(options, name);
      if (eq < arg->len) {
        if (strict && !desc) {
          pa_unknown(raw);
          scr_str_release(raw);
          scr_str_release(name);
          goto fail;
        }
        if (strict && pa_desc_type(desc) == 0) {
          pa_takes_no_value(raw);
          scr_str_release(raw);
          scr_str_release(name);
          goto fail;
        }
        ScrStr *value = pa_str_bytes(arg->data + eq + 1, arg->len - eq - 1);
        pa_store(values, tokens, desc, name, raw, i, value, true, 1);
        scr_str_release(value);
      } else if (desc && pa_desc_type(desc) == 1) {
        if (i + 1 < args->v.arr.len) {
          const ScrStr *value = args->v.arr.items[++i]->v.str;
          if (strict && value->len > 1 && value->data[0] == '-') {
            pa_ambiguous(raw, name, false);
            scr_str_release(raw);
            scr_str_release(name);
            goto fail;
          }
          pa_store(values, tokens, desc, name, raw, i - 1, value, true, 0);
        } else if (strict) {
          pa_missing_long(raw);
          scr_str_release(raw);
          scr_str_release(name);
          goto fail;
        } else {
          pa_store(values, tokens, desc, name, raw, i, NULL, true, -1);
        }
      } else if (allow_negative && name->len > 3 &&
                 memcmp(name->data, "no-", 3) == 0) {
        ScrStr *positive = pa_str_bytes(name->data + 3, name->len - 3);
        const ScrDyn *positive_desc = pa_find_long(options, positive);
        if (positive_desc && pa_desc_type(positive_desc) == 0) {
          pa_store(values, tokens, positive_desc, positive, raw, i,
                   NULL, false, -1);
          scr_str_release(positive);
        } else {
          scr_str_release(positive);
          if (strict && !desc) {
            pa_unknown(raw);
            scr_str_release(raw);
            scr_str_release(name);
            goto fail;
          }
          pa_store(values, tokens, desc, name, raw, i, NULL, true, -1);
        }
      } else {
        if (strict && !desc) {
          pa_unknown(raw);
          scr_str_release(raw);
          scr_str_release(name);
          goto fail;
        }
        pa_store(values, tokens, desc, name, raw, i, NULL, true, -1);
      }
      scr_str_release(raw);
      scr_str_release(name);
      continue;
    }

    if (arg->len > 1 && arg->data[0] == '-') {
      double units = scr_str_utf16_len((ScrStr *)arg);
      for (double at = 1; at < units; at++) {
        ScrStr *short_name = scr_str_char_at((ScrStr *)arg, at);
        const char *long_bytes = short_name->data;
        size_t long_len = short_name->len;
        const ScrDyn *desc = pa_find_short(options, short_name,
                                           &long_bytes, &long_len);
        ScrStr *name = pa_str_bytes(long_bytes, long_len);
        char *raw_bytes = malloc(short_name->len + 1);
        if (!raw_bytes) {
          fputs("scriptc: out of memory\n", stderr);
          abort();
        }
        raw_bytes[0] = '-';
        memcpy(raw_bytes + 1, short_name->data, short_name->len);
        ScrStr *raw = pa_str_bytes(raw_bytes, short_name->len + 1);
        free(raw_bytes);
        if (strict && !desc) {
          pa_unknown(raw);
          scr_str_release(raw);
          scr_str_release(name);
          scr_str_release(short_name);
          goto fail;
        }
        if (desc && pa_desc_type(desc) == 1) {
          if (at + 1 < units) {
            ScrStr *value = scr_str_slice((ScrStr *)arg, at + 1, INFINITY);
            pa_store(values, tokens, desc, name, raw, i, value, true, 1);
            scr_str_release(value);
          } else if (i + 1 < args->v.arr.len) {
            const ScrStr *value = args->v.arr.items[++i]->v.str;
            if (strict && value->len > 1 && value->data[0] == '-') {
              pa_ambiguous(raw, name, true);
              scr_str_release(raw);
              scr_str_release(name);
              scr_str_release(short_name);
              goto fail;
            }
            pa_store(values, tokens, desc, name, raw, i - 1, value, true, 0);
          } else if (strict) {
            pa_missing_short(raw, name);
            scr_str_release(raw);
            scr_str_release(name);
            scr_str_release(short_name);
            goto fail;
          } else {
            pa_store(values, tokens, desc, name, raw, i, NULL, true, -1);
          }
          scr_str_release(raw);
          scr_str_release(name);
          scr_str_release(short_name);
          break;
        }
        pa_store(values, tokens, desc, name, raw, i, NULL, true, -1);
        scr_str_release(raw);
        scr_str_release(name);
        scr_str_release(short_name);
      }
      continue;
    }

    if (strict && !allow_positionals) {
      pa_unexpected(arg);
      goto fail;
    }
    pa_positional(positionals, tokens, arg, i);
  }

  if (options) {
    for (size_t i = 0; i < options->v.obj.len; i++) {
      const ScrDynEntry *entry = &options->v.obj.entries[i];
      if (scr_dyn_obj_get(values, entry->key, entry->key_len)) continue;
      const ScrDyn *def = pa_member(entry->value, "default");
      if (def) {
        scr_dyn_obj_set(values, entry->key, entry->key_len,
                        scr_dyn_retain((ScrDyn *)def));
      }
    }
  }

  scr_dyn_obj_set(result, "values", 6, values);
  scr_dyn_obj_set(result, "positionals", 11, positionals);
  if (tokens) scr_dyn_obj_set(result, "tokens", 6, tokens);
  scr_dyn_release(owned_args);
  return result;

fail:
  scr_dyn_release(tokens);
  scr_dyn_release(positionals);
  scr_dyn_release(values);
  scr_dyn_release(result);
  scr_dyn_release(owned_args);
  return NULL;
}
