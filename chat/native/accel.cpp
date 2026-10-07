// ------------------------------------------------------------------
// accel.cpp —— 可选的 C++ / WebAssembly 加速模块
//
// 作用：为前端提供一个用 C++ 实现的 SHA-256，供密码哈希（PBKDF2 式迭代）
//       提速。纯可选：加载失败时前端自动回退到纯 JS 实现，功能完全不受影响。
//
// 原生编译自测（不需要 emscripten）：
//     g++ -O2 -std=c++17 native/accel.cpp -o accel && ./accel
//     应输出 SHA-256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396...
//
// 编译为 WASM（需要 emscripten）：
//     emcc -O3 -std=c++17 native/accel.cpp -o native/accel.wasm \
//          -sEXPORTED_FUNCTIONS=_sha256_hex,_accel_alloc,_accel_free,_accel_selftest \
//          -sEXPORTED_RUNTIME_METHODS=ccall,cwrap -sINITIAL_MEMORY=65536 --no-entry
//     产物放在 native/accel.wasm，前端 js/net.js 会自动探测并启用。
//
// 许可：MIT（见仓库 LICENSE）
// ------------------------------------------------------------------
#include <cstdint>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <string>

#ifdef EMSCRIPTEN
#include <emscripten/emscripten.h>
#define ACCEL_EXPORT extern "C" __attribute__((visibility("default"))) EMSCRIPTEN_KEEPALIVE
#else
#define EMSCRIPTEN_KEEPALIVE
#define ACCEL_EXPORT extern "C"
#endif

namespace {

inline uint32_t rotr(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }

static const uint32_t K[64] = {
    0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u,
    0x923f82a4u, 0xab1c5ed5u, 0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u,
    0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u, 0xe49b69c1u, 0xefbe4786u,
    0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
    0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u,
    0x06ca6351u, 0x14292967u, 0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u,
    0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u, 0xa2bfe8a1u, 0xa81a664bu,
    0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
    0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au,
    0x5b9cca4fu, 0x682e6ff3u, 0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
    0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u};

void sha256_raw(const uint8_t* data, size_t len, uint8_t out[32]) {
    uint32_t h[8] = {0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
                     0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u};
    uint64_t bitlen = (uint64_t)len * 8;
    size_t full = len;
    // 计算补齐后的总长度（1 字节 0x80 + 补零 + 8 字节长度，对齐到 64）
    size_t total = ((len + 8) / 64 + 1) * 64;
    uint8_t* buf = (uint8_t*)malloc(total ? total : 64);
    if (!buf) return;
    memcpy(buf, data, len);
    buf[len] = 0x80;
    memset(buf + len + 1, 0, total - len - 1);
    for (int i = 0; i < 8; ++i) buf[total - 1 - i] = (uint8_t)(bitlen >> (8 * i));

    for (size_t off = 0; off < total; off += 64) {
        uint32_t w[64];
        for (int i = 0; i < 16; ++i) {
            w[i] = ((uint32_t)buf[off + i * 4] << 24) | ((uint32_t)buf[off + i * 4 + 1] << 16) |
                   ((uint32_t)buf[off + i * 4 + 2] << 8) | (uint32_t)buf[off + i * 4 + 3];
        }
        for (int i = 16; i < 64; ++i) {
            uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
            uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16] + s0 + w[i - 7] + s1;
        }
        uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
        for (int i = 0; i < 64; ++i) {
            uint32_t S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            uint32_t ch = (e & f) ^ (~e & g);
            uint32_t t1 = hh + S1 + ch + K[i] + w[i];
            uint32_t S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            uint32_t mj = (a & b) ^ (a & c) ^ (b & c);
            uint32_t t2 = S0 + mj;
            hh = g; g = f; f = e; e = d + t1;
            d = c; c = b; b = a; a = t1 + t2;
        }
        h[0] += a; h[1] += b; h[2] += c; h[3] += d;
        h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    }
    free(buf);
    for (int i = 0; i < 8; ++i) {
        out[i * 4] = (uint8_t)(h[i] >> 24);
        out[i * 4 + 1] = (uint8_t)(h[i] >> 16);
        out[i * 4 + 2] = (uint8_t)(h[i] >> 8);
        out[i * 4 + 3] = (uint8_t)(h[i]);
    }
    (void)full;
}

// 输出缓冲区：固定 64 字节，避免调用方给的 out 空间不足而越界。
char g_hex[65];

}  // namespace

ACCEL_EXPORT const char* sha256_hex(const char* in, int len, char* /*out*/) {
    uint8_t digest[32];
    if (!in || len < 0) len = 0;
    sha256_raw((const uint8_t*)in, (size_t)len, digest);
    static const char* tab = "0123456789abcdef";
    for (int i = 0; i < 32; ++i) {
        g_hex[i * 2] = tab[(digest[i] >> 4) & 0xF];
        g_hex[i * 2 + 1] = tab[digest[i] & 0xF];
    }
    g_hex[64] = 0;
    return g_hex;
}

ACCEL_EXPORT void* accel_alloc(int n) { return malloc(n > 0 ? (size_t)n : 1); }

ACCEL_EXPORT void accel_free(void* p) { free(p); }

ACCEL_EXPORT int accel_selftest() {
    // SHA-256("abc") 的前 8 字节应为 ba7816bf8f01cfea
    const char* h = sha256_hex("abc", 3, nullptr);
    return (strncmp(h, "ba7816bf8f01cfea", 16) == 0) ? 1 : 0;
}

#ifndef EMSCRIPTEN
int main() {
    printf("[accel] selftest = %s\n", accel_selftest() ? "PASS" : "FAIL");
    printf("[accel] SHA-256(\"abc\") = %s\n", sha256_hex("abc", 3, nullptr));
    printf("[accel] SHA-256(\"\")    = %s\n", sha256_hex("", 0, nullptr));
    return accel_selftest() ? 0 : 1;
}
#endif
