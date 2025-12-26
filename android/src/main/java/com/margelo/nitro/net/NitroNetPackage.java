package com.margelo.nitro.net;

import androidx.annotation.NonNull;
import com.facebook.react.ReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.uimanager.ViewManager;
import java.util.Collections;
import java.util.List;
import android.util.Log;

public class NitroNetPackage implements ReactPackage {
    static {
        try {
            System.loadLibrary("RustCNet");
        } catch (Throwable e) {
            Log.e("NitroNetPackage", "Failed to load RustCNet library", e);
        }
    }

    @NonNull
    @Override
    public List<NativeModule> createNativeModules(@NonNull ReactApplicationContext reactContext) {
        return Collections.emptyList();
    }

    @NonNull
    @Override
    public List<ViewManager> createViewManagers(@NonNull ReactApplicationContext reactContext) {
        return Collections.emptyList();
    }
}
