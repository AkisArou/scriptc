/* musl libc shim — compiled into linux-musl target builds only (cc.ts adds
 * this TU together with -DSCR_MUSL). musl deliberately provides no libc
 * identification macro, so the target-selected project macro is the guard.
 *
 * The x86_64 ucontext implementation below is derived from libucontext
 * commit 49e671dd52ff6791295d8161ad3b6da7dc5f6f9d:
 * https://github.com/kaniini/libucontext
 *
 * Copyright (c) 2018-2025 Ariadne Conill <ariadne@dereferenced.org>
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * This software is provided 'as is' and without any warranty, express or
 * implied. In no event shall the authors be liable for any damages arising
 * from the use of this software. */
#ifdef SCR_MUSL

#include "scr_runtime.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/random.h>
#ifndef SCR_LIB
#include <stdarg.h>
#include <ucontext.h>
#endif

#if !defined(__x86_64__)
#error "scriptc's musl runtime currently supports x86_64 only"
#endif

/* The scriptc runtime uses arc4random_buf as its infallible CSPRNG contract.
 * Linux getrandom has the same kernel source and needs neither mutable state
 * nor an fd. Retry interrupts and short reads; any other failure aborts rather
 * than returning predictable or partially initialized bytes. */
void arc4random_buf(void *buf, size_t n) {
  unsigned char *p = buf;
  while (n > 0) {
    ssize_t got = getrandom(p, n, 0);
    if (got > 0) {
      p += (size_t)got;
      n -= (size_t)got;
      continue;
    }
    if (got < 0 && errno == EINTR) continue;
    fputs("scriptc: getrandom failed\n", stderr);
    abort();
  }
}

/* Library artifacts contain no fibers or event loop, so they need only the
 * CSPRNG shim above and must not acquire context-switching definitions. */
#ifndef SCR_LIB

/* musl exposes the POSIX ucontext types but intentionally omits these legacy
 * functions. scriptc's async/generator fibers need only user-space register
 * swaps; they never use a context to mutate the process signal mask. This is
 * libucontext's fast (non-POSIX-signal-mask) x86_64 implementation, emitted
 * under the standard symbol names that musl leaves unresolved. */
_Static_assert(offsetof(ucontext_t, uc_mcontext.gregs) == 40,
               "unexpected musl x86_64 ucontext layout");
_Static_assert(offsetof(ucontext_t, uc_mcontext.fpregs) == 224,
               "unexpected musl x86_64 fpregs layout");
_Static_assert(offsetof(ucontext_t, __fpregs_mem) == 424,
               "unexpected musl x86_64 fpregs storage layout");

/* Keep the assembler independent of whether the sysroot exposes glibc's
 * REG_* spellings as enum constants, self-referential macros, or neither. */
#undef REG_R8
#undef REG_R9
#undef REG_R10
#undef REG_R11
#undef REG_R12
#undef REG_R13
#undef REG_R14
#undef REG_R15
#undef REG_RDI
#undef REG_RSI
#undef REG_RBP
#undef REG_RBX
#undef REG_RDX
#undef REG_RAX
#undef REG_RCX
#undef REG_RSP
#undef REG_RIP
#define REG_R8 0
#define REG_R9 1
#define REG_R10 2
#define REG_R11 3
#define REG_R12 4
#define REG_R13 5
#define REG_R14 6
#define REG_R15 7
#define REG_RDI 8
#define REG_RSI 9
#define REG_RBP 10
#define REG_RBX 11
#define REG_RDX 12
#define REG_RAX 13
#define REG_RCX 14
#define REG_RSP 15
#define REG_RIP 16

#define SCR_STR_INNER(x) #x
#define SCR_STR(x) SCR_STR_INNER(x)
#define SCR_UC_GREG(reg) (40 + ((reg) * 8))

__asm__(
    ".text\n"
    ".global getcontext\n"
    "getcontext:\n"
    "  movq %r8, "  SCR_STR(SCR_UC_GREG(REG_R8))  "(%rdi)\n"
    "  movq %r9, "  SCR_STR(SCR_UC_GREG(REG_R9))  "(%rdi)\n"
    "  movq %r10, " SCR_STR(SCR_UC_GREG(REG_R10)) "(%rdi)\n"
    "  movq %r11, " SCR_STR(SCR_UC_GREG(REG_R11)) "(%rdi)\n"
    "  movq %r12, " SCR_STR(SCR_UC_GREG(REG_R12)) "(%rdi)\n"
    "  movq %r13, " SCR_STR(SCR_UC_GREG(REG_R13)) "(%rdi)\n"
    "  movq %r14, " SCR_STR(SCR_UC_GREG(REG_R14)) "(%rdi)\n"
    "  movq %r15, " SCR_STR(SCR_UC_GREG(REG_R15)) "(%rdi)\n"
    "  movq %rdi, " SCR_STR(SCR_UC_GREG(REG_RDI)) "(%rdi)\n"
    "  movq %rsi, " SCR_STR(SCR_UC_GREG(REG_RSI)) "(%rdi)\n"
    "  movq %rbp, " SCR_STR(SCR_UC_GREG(REG_RBP)) "(%rdi)\n"
    "  movq %rbx, " SCR_STR(SCR_UC_GREG(REG_RBX)) "(%rdi)\n"
    "  movq %rdx, " SCR_STR(SCR_UC_GREG(REG_RDX)) "(%rdi)\n"
    "  movq %rax, " SCR_STR(SCR_UC_GREG(REG_RAX)) "(%rdi)\n"
    "  movq %rcx, " SCR_STR(SCR_UC_GREG(REG_RCX)) "(%rdi)\n"
    "  movq (%rsp), %rcx\n"
    "  movq %rcx, " SCR_STR(SCR_UC_GREG(REG_RIP)) "(%rdi)\n"
    "  leaq 8(%rsp), %rcx\n"
    "  movq %rcx, " SCR_STR(SCR_UC_GREG(REG_RSP)) "(%rdi)\n"
    "  leaq 424(%rdi), %rcx\n"
    "  movq %rcx, 224(%rdi)\n"
    "  fnstenv (%rcx)\n"
    "  fldenv (%rcx)\n"
    "  stmxcsr 448(%rdi)\n"
    "  xorl %eax, %eax\n"
    "  ret\n"

    ".global setcontext\n"
    "setcontext:\n"
    "  movq 224(%rdi), %rcx\n"
    "  fldenv (%rcx)\n"
    "  ldmxcsr 448(%rdi)\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_R8))  "(%rdi), %r8\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_R9))  "(%rdi), %r9\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_R10)) "(%rdi), %r10\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_R11)) "(%rdi), %r11\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_R12)) "(%rdi), %r12\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_R13)) "(%rdi), %r13\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_R14)) "(%rdi), %r14\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_R15)) "(%rdi), %r15\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_RSI)) "(%rdi), %rsi\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_RBP)) "(%rdi), %rbp\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_RBX)) "(%rdi), %rbx\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_RDX)) "(%rdi), %rdx\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_RAX)) "(%rdi), %rax\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_RCX)) "(%rdi), %rcx\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_RSP)) "(%rdi), %rsp\n"
    "  pushq " SCR_STR(SCR_UC_GREG(REG_RIP)) "(%rdi)\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_RDI)) "(%rdi), %rdi\n"
    "  xorl %eax, %eax\n"
    "  ret\n"

    ".global swapcontext\n"
    "swapcontext:\n"
    "  movq %r8, "  SCR_STR(SCR_UC_GREG(REG_R8))  "(%rdi)\n"
    "  movq %r9, "  SCR_STR(SCR_UC_GREG(REG_R9))  "(%rdi)\n"
    "  movq %r10, " SCR_STR(SCR_UC_GREG(REG_R10)) "(%rdi)\n"
    "  movq %r11, " SCR_STR(SCR_UC_GREG(REG_R11)) "(%rdi)\n"
    "  movq %r12, " SCR_STR(SCR_UC_GREG(REG_R12)) "(%rdi)\n"
    "  movq %r13, " SCR_STR(SCR_UC_GREG(REG_R13)) "(%rdi)\n"
    "  movq %r14, " SCR_STR(SCR_UC_GREG(REG_R14)) "(%rdi)\n"
    "  movq %r15, " SCR_STR(SCR_UC_GREG(REG_R15)) "(%rdi)\n"
    "  movq %rdi, " SCR_STR(SCR_UC_GREG(REG_RDI)) "(%rdi)\n"
    "  movq %rsi, " SCR_STR(SCR_UC_GREG(REG_RSI)) "(%rdi)\n"
    "  movq %rbp, " SCR_STR(SCR_UC_GREG(REG_RBP)) "(%rdi)\n"
    "  movq %rbx, " SCR_STR(SCR_UC_GREG(REG_RBX)) "(%rdi)\n"
    "  movq %rdx, " SCR_STR(SCR_UC_GREG(REG_RDX)) "(%rdi)\n"
    "  movq %rax, " SCR_STR(SCR_UC_GREG(REG_RAX)) "(%rdi)\n"
    "  movq %rcx, " SCR_STR(SCR_UC_GREG(REG_RCX)) "(%rdi)\n"
    "  movq (%rsp), %rcx\n"
    "  movq %rcx, " SCR_STR(SCR_UC_GREG(REG_RIP)) "(%rdi)\n"
    "  leaq 8(%rsp), %rcx\n"
    "  movq %rcx, " SCR_STR(SCR_UC_GREG(REG_RSP)) "(%rdi)\n"
    "  leaq 424(%rdi), %rcx\n"
    "  movq %rcx, 224(%rdi)\n"
    "  fnstenv (%rcx)\n"
    "  fldenv (%rcx)\n"
    "  stmxcsr 448(%rdi)\n"
    "  movq 224(%rsi), %rcx\n"
    "  fldenv (%rcx)\n"
    "  ldmxcsr 448(%rsi)\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_R8))  "(%rsi), %r8\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_R9))  "(%rsi), %r9\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_R10)) "(%rsi), %r10\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_R11)) "(%rsi), %r11\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_R12)) "(%rsi), %r12\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_R13)) "(%rsi), %r13\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_R14)) "(%rsi), %r14\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_R15)) "(%rsi), %r15\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_RDI)) "(%rsi), %rdi\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_RBP)) "(%rsi), %rbp\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_RBX)) "(%rsi), %rbx\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_RDX)) "(%rsi), %rdx\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_RAX)) "(%rsi), %rax\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_RCX)) "(%rsi), %rcx\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_RSP)) "(%rsi), %rsp\n"
    "  pushq " SCR_STR(SCR_UC_GREG(REG_RIP)) "(%rsi)\n"
    "  movq " SCR_STR(SCR_UC_GREG(REG_RSI)) "(%rsi), %rsi\n"
    "  xorl %eax, %eax\n"
    "  ret\n"

    ".hidden scr_musl_context_trampoline\n"
    "scr_musl_context_trampoline:\n"
    "  movq (%rbx), %rdi\n"
    "  testq %rdi, %rdi\n"
    "  je 1f\n"
    "  call setcontext\n"
    "  ud2\n"
    "1:\n"
    "  xorl %edi, %edi\n"
    "  call exit\n"
    "  ud2\n");

extern void scr_musl_context_trampoline(void);

void makecontext(ucontext_t *ucp, void (*func)(void), int argc, ...) {
  greg_t *sp;
  va_list va;
  int i;
  unsigned int link_slot = (unsigned int)(argc > 6 ? argc - 6 : 0) + 1;

  sp = (greg_t *)((uintptr_t)ucp->uc_stack.ss_sp + ucp->uc_stack.ss_size);
  sp -= link_slot;
  sp = (greg_t *)(((uintptr_t)sp & ~(uintptr_t)15) - 8);

  ucp->uc_mcontext.fpregs = (void *)&ucp->__fpregs_mem;
  ucp->uc_mcontext.gregs[REG_RIP] = (greg_t)(uintptr_t)func;
  ucp->uc_mcontext.gregs[REG_RBX] = (greg_t)(uintptr_t)&sp[link_slot];
  ucp->uc_mcontext.gregs[REG_RSP] = (greg_t)(uintptr_t)sp;

  sp[0] = (greg_t)(uintptr_t)&scr_musl_context_trampoline;
  sp[link_slot] = (greg_t)(uintptr_t)ucp->uc_link;

  va_start(va, argc);
  for (i = 0; i < argc; i++) {
    greg_t arg = va_arg(va, greg_t);
    switch (i) {
      case 0: ucp->uc_mcontext.gregs[REG_RDI] = arg; break;
      case 1: ucp->uc_mcontext.gregs[REG_RSI] = arg; break;
      case 2: ucp->uc_mcontext.gregs[REG_RDX] = arg; break;
      case 3: ucp->uc_mcontext.gregs[REG_RCX] = arg; break;
      case 4: ucp->uc_mcontext.gregs[REG_R8] = arg; break;
      case 5: ucp->uc_mcontext.gregs[REG_R9] = arg; break;
      default: sp[i - 5] = arg; break;
    }
  }
  va_end(va);
}

#undef SCR_UC_GREG
#undef SCR_STR
#undef SCR_STR_INNER

#endif /* !SCR_LIB */

#else /* !SCR_MUSL */

typedef int scr_musl_unused;

#endif /* SCR_MUSL */
