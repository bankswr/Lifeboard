package org.lifeboard.app.widgets;

import android.app.Activity;
import android.appwidget.AppWidgetManager;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ArrayAdapter;
import android.widget.ListView;
import android.widget.TextView;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Shown when a Lists widget is placed (or reconfigured): pick which to-do list it shows.
 * The lists come from the app's snapshot; before the app has run once there are none, and
 * the widget falls back to the first list once there is one.
 */
public class ListsWidgetConfigure extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        int widgetId = getIntent().getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
        // Backing out without choosing cancels placing the widget.
        setResult(RESULT_CANCELED, new Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId));
        if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
            finish();
            return;
        }

        List<String> ids = new ArrayList<>();
        List<String> names = new ArrayList<>();
        JSONObject snapshot = WidgetStore.snapshot(this);
        JSONArray lists = snapshot == null ? null : snapshot.optJSONArray("lists");
        for (int i = 0; lists != null && i < lists.length(); i++) {
            JSONObject list = lists.optJSONObject(i);
            if (list == null) continue;
            ids.add(list.optString("id"));
            names.add(list.optString("title"));
        }
        if (ids.isEmpty()) {
            // Nothing to choose yet: place the widget anyway; it shows the first list later.
            done(widgetId);
            return;
        }

        ListView view = new ListView(this);
        view.setBackgroundColor(Color.parseColor("#0f172a"));
        view.setAdapter(new ArrayAdapter<String>(this, android.R.layout.simple_list_item_1, names) {
            @Override
            public View getView(int position, View convertView, ViewGroup parent) {
                TextView text = (TextView) super.getView(position, convertView, parent);
                text.setTextColor(RowsWidget.TEXT);
                return text;
            }
        });
        view.setOnItemClickListener((parent, item, position, id) -> {
            WidgetStore.setListFor(this, widgetId, ids.get(position));
            done(widgetId);
        });
        setTitle("Choose a list");
        setContentView(view);
    }

    private void done(int widgetId) {
        new ListsWidget().draw(this, AppWidgetManager.getInstance(this), widgetId);
        setResult(RESULT_OK, new Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId));
        finish();
    }
}
