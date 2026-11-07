package app.caldesk.mobile;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

/**
 * 返回键接线。
 *
 * Capacitor 的 BridgeActivity 自己不处理返回键，而项目里没有装 @capacitor/app，
 * 所以系统返回键会直接 finish 掉这个 Activity —— 用户想关掉一个弹层，结果 App 没了。
 *
 * 这里只做一件事：把手势/实体返回交给 WebView 的历史。
 * 前端（MobileApp.tsx）在打开弹层、确认框、二级页时 pushState，
 * 按返回时 popstate 把那一层关掉；历史里没东西可回才交回系统（退出应用）。
 *
 * 用 OnBackPressedDispatcher 而不是重写 onBackPressed：后者在 API 33+ 已废弃。
 * 这个文件是 `cap add android` 生成后交给应用自己维护的地方，`cap sync` 不会覆盖它。
 */
public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = getBridge() == null ? null : getBridge().getWebView();
                if (webView != null && webView.canGoBack()) {
                    webView.goBack();
                    return;
                }
                /*
                 * 没有可回退的页面：交给系统默认行为（退出应用）。
                 * 关掉自己再重新打开，是因为 onBackPressed() 只在不被拦截时才会走到系统那边；
                 * 用完立刻恢复，否则这一次之后返回键就再也不问 WebView 了。
                 */
                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
                setEnabled(true);
            }
        });
    }
}
