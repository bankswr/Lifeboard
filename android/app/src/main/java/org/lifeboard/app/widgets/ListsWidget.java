package org.lifeboard.app.widgets;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * One to-do list, chosen when the widget is placed (ListsWidgetConfigure). Tapping an item
 * crosses it out (or back) at once and queues the change; the app applies queued ticks
 * through its normal code the next time it runs (src/app/widgets.ts), so this class never
 * writes to the app's database.
 */
public class ListsWidget extends RowsWidget {

    static final String ACTION_TICK = "org.lifeboard.app.widgets.TICK";
    private static final String EXTRA_ITEM = "itemId";
    private static final String EXTRA_DONE = "done";

    @Override
    String key() {
        return "lists";
    }

    /** The chosen list (the first list if none was chosen or it was deleted), with queued ticks shown. */
    @Override
    JSONObject content(Context context, int widgetId) {
        JSONObject snapshot = WidgetStore.snapshot(context);
        JSONArray lists = snapshot == null ? null : snapshot.optJSONArray("lists");
        if (lists == null || lists.length() == 0) return null;
        String chosen = WidgetStore.listFor(context, widgetId);
        JSONObject list = lists.optJSONObject(0);
        for (int i = 0; i < lists.length(); i++) {
            JSONObject candidate = lists.optJSONObject(i);
            if (candidate != null && candidate.optString("id").equals(chosen)) list = candidate;
        }
        return withQueuedTicks(context, list);
    }

    private static JSONObject withQueuedTicks(Context context, JSONObject list) {
        JSONObject ticks = WidgetStore.ticks(context);
        JSONArray rows = list.optJSONArray("rows");
        if (rows == null || ticks.length() == 0) return list;
        try {
            for (int i = 0; i < rows.length(); i++) {
                JSONObject row = rows.getJSONObject(i);
                String itemId = row.optString("itemId");
                if (ticks.has(itemId)) row.put("done", ticks.getBoolean(itemId));
            }
        } catch (JSONException e) {
            // A malformed row is drawn as the snapshot had it.
        }
        return list;
    }

    @Override
    Intent rowFillIn(JSONObject row, String widgetLink) {
        if (!row.has("itemId")) return super.rowFillIn(row, widgetLink);
        return new Intent()
            .putExtra(EXTRA_ITEM, row.optString("itemId"))
            .putExtra(EXTRA_DONE, !row.optBoolean("done", false));
    }

    /** Row taps come back here as a broadcast, so ticking doesn't open the app. */
    @Override
    PendingIntent rowTemplate(Context context, int widgetId) {
        Intent intent = new Intent(context, ListsWidget.class).setAction(ACTION_TICK);
        return PendingIntent.getBroadcast(context, widgetId, intent, PendingIntent.FLAG_UPDATE_CURRENT | mutable());
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        if (ACTION_TICK.equals(intent.getAction()) && intent.hasExtra(EXTRA_ITEM)) {
            WidgetStore.queueTick(context, intent.getStringExtra(EXTRA_ITEM), intent.getBooleanExtra(EXTRA_DONE, true));
            redrawAll(context);
            return;
        }
        super.onReceive(context, intent);
    }

    @Override
    public void onDeleted(Context context, int[] widgetIds) {
        for (int widgetId : widgetIds) WidgetStore.forgetWidget(context, widgetId);
    }

    static void redrawAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        ListsWidget widget = new ListsWidget();
        for (int widgetId : manager.getAppWidgetIds(new ComponentName(context, ListsWidget.class))) {
            widget.draw(context, manager, widgetId);
        }
    }
}
