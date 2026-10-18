package org.lifeboard.app.widgets;

import android.app.Activity;
import android.appwidget.AppWidgetManager;
import android.os.Bundle;
import android.view.inputmethod.EditorInfo;
import android.widget.EditText;
import org.json.JSONObject;
import org.lifeboard.app.R;

/**
 * The Lists widget's "+" pop-up, shown over the home screen without starting the app. The
 * typed item is only queued (WidgetStore.queueAdd) and shown on the widget at once; the app
 * adds it to the list through its normal code the next time it runs (src/app/widgets.ts).
 */
public class ListAddActivity extends Activity {

    static final String EXTRA_WIDGET_ID = "widgetId";

    private EditText text;
    private int widgetId;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        widgetId = getIntent().getIntExtra(EXTRA_WIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
        JSONObject list = ListsWidget.shownList(this, widgetId);
        if (list == null) {
            finish();
            return;
        }
        setTitle(getString(R.string.widget_add_title, list.optString("title")));
        setContentView(R.layout.widget_add);

        text = findViewById(R.id.add_text);
        text.requestFocus();
        text.setOnEditorActionListener((view, action, event) -> {
            if (action != EditorInfo.IME_ACTION_DONE) return false;
            add();
            return true;
        });
        findViewById(R.id.add_confirm).setOnClickListener(view -> add());
        findViewById(R.id.add_cancel).setOnClickListener(view -> finish());
    }

    /** Queues the typed item for the widget's list (looked up again, in case the snapshot changed). */
    private void add() {
        String item = text.getText().toString().trim();
        if (item.isEmpty()) return;
        JSONObject list = ListsWidget.shownList(this, widgetId);
        if (list != null) {
            WidgetStore.queueAdd(this, list.optString("id"), item);
            RowsWidget.redrawAll(this, new ListsWidget());
        }
        finish();
    }
}
