package io.liuyiming.chat.core

/**
 * 纯逻辑规则。**刻意不 import 任何 android.* 包**。
 *
 * ⚠ 为什么单独拆一个文件出来（NATIVE-TEST）：
 * 这些判定以前散在 ChatViewModel 里，而 ViewModel 依赖 androidx.lifecycle、
 * 又依赖 ChatApp（里面有 Room、OkHttp）—— 于是它在 JVM 上根本没法实例化，
 * "发送前校验长度"这条**最要紧的规则就从没被自动化验证过**。
 *
 * 规则全部挪到这里后，单元测试可以直接跑，不需要 Robolectric，
 * 也不需要在 CI 上开模拟器。
 *
 * ⚠ 这一类规则恰恰是最该被测的：
 *   长度校验漏了 → 用户写半小时的东西被服务端拒，输入框已清空，内容没了；
 *   撤回时限判错了 → 要么撤不掉该撤的，要么能撤不该撤的。
 * 它们都不难，但错了的代价很高，而且**错了没有任何提示**。
 */
object Rules {
    /** 与服务端一致。改这里必须同步改服务端的 8000 上限。 */
    const val MAX_LEN = 8000

    /** 撤回时限。服务端才是真正的闸门，这里只负责给出正确提示。 */
    const val REVOKE_WINDOW_MS = 6 * 60 * 1000L

    /**
     * 是否超长。
     *
     * ⚠ 用 **trim 之后**的长度判定，且必须与发送时的处理一致 ——
     * 发送前会 trim，若这里用原始长度，用户看到"超长"但实际能发出去，
     * 或者反过来：提示能发、发出去被拒。两端口径不一致是纯粹的 bug 制造机。
     */
    fun overLimit(text: String): Boolean = text.trim().length > MAX_LEN

    /** 剩余可输入字数。用于"实时提示"而不是等到点了发送才说。 */
    fun remaining(text: String): Int = (MAX_LEN - text.trim().length).coerceAtLeast(0)

    /**
     * 能否撤回。
     *
     * ⚠ now 由外部传入而不是内部读时钟 —— 否则这条函数没法被测试，
     * 测试只能靠 sleep 或者改系统时间。
     */
    fun canRevoke(at: Long, now: Long): Boolean = (now - at) <= REVOKE_WINDOW_MS

    /**
     * 撤回后还剩多少毫秒。负数表示已超时。
     *
     * ⚠ 超时后按钮**不消失**而是标"已超时"（NATIVE-MSG）——
     * 凭空消失的话用户只会以为功能坏了，而不是"我来晚了"。
     */
    fun revokeLeftMs(at: Long, now: Long): Long = REVOKE_WINDOW_MS - (now - at)
}
