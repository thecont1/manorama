package in.thecontrarian.manorama;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import in.thecontrarian.manorama.events.EventClusteringPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(EventClusteringPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
