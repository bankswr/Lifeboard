package org.lifeboard.app.widgets;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.view.View;
import android.widget.RemoteViews;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.lifeboard.app.R;

/**
 * One to-do list, chosen when the widget is placed (ListsWidgetConfigure). Tapping an item
 * crosses it out (or back) at once and queues the change; the header's "+" opens a pop-up
 * (ListAddActivity) whose item is queued and shown at once. The app applies both queues
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

    /** The chosen list (the first list if none was chosen or it was deleted), with queued changes shown. */
    @Override
    JSONObject content(Context context, int widgetId) {
        JSONObject list = shownList(context, widgetId);
        if (list == null) return null;
        withQueuedTicks(list, WidgetStore.ticks(context, WidgetStore.LIST_TICKS));
        return withQueuedAdds(context, list);
    }

    /** The list this widget shows, as in the snapshot, or null before the app has run once. */
    static JSONObject shownList(Context context, int widgetId) {
        JSONObject snapshot = WidgetStore.snapshot(context);
        JSONArray lists = snapshot == null ? null : snapshot.optJSONArray("lists");
        if (lists == null || lists.length() == 0) return null;
        String chosen = WidgetStore.listFor(context, widgetId);
        JSONObject list = lists.optJSONObject(0);
        for (int i = 0; i < lists.length(); i++) {
            JSONObject candidate = lists.optJSONObject(i);
            if (candidate != null && candidate.optString("id").equals(chosen)) list = candidate;
        }
        return list;
    }

    /**
     * Items added on the widget and not yet saved by the app, after the open items. They have
     * no id yet, so they can't be ticked until the app has added them.
     */
    private static JSONObject withQueuedAdds(Context context, JSONObject list) {
        JSONArray adds = WidgetStore.adds(context);
        JSONArray rows = list.optJSONArray("rows");
        if (rows == null || adds.length() == 0) return list;
        try {
            JSONArray open = new JSONArray();
            JSONArray done = new JSONArray();
            for (int i = 0; i < rows.length(); i++) {
                JSONObject row = rows.getJSONObject(i);
                (row.optBoolean("done", false) ? done : open).put(row);
            }
            for (int i = 0; i < adds.length(); i++) {
                JSONObject add = adds.getJSONObject(i);
                if (!add.optString("listId").equals(list.optString("id"))) continue;
                open.put(new JSONObject()
                    .put("title", add.optString("text"))
                    .put("sub", "Added when Lifeboard next opens")
                    .put("style", "normal"));
            }
            for (int i = 0; i < done.length(); i++) open.put(done.get(i));
            list.put("rows", open);
        } catch (JSONException e) {
            // Drawn as the snapshot had it; the queued items still get added by the app.
        }
        return list;
    }

    /** The "+" in the header opens the add pop-up for this widget's list. */
    @Override
    void decorateHeader(Context context, RemoteViews views, int widgetId, JSONObject content) {
        Intent intent = new Intent(context, ListAddActivity.class).putExtra(ListAddActivity.EXTRA_WIDGET_ID, widgetId);
        PendingIntent add = PendingIntent.getActivity(context, 20_000 + widgetId, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        views.setViewVisibility(R.id.widget_add, View.VISIBLE);
        views.setOnClickPendingIntent(R.id.widget_add, add);
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
            WidgetStore.queueTick(context, WidgetStore.LIST_TICKS, intent.getStringExtra(EXTRA_ITEM), intent.getBooleanExtra(EXTRA_DONE, true));
            redrawAll(context, this);
            return;
        }
        super.onReceive(context, intent);
    }

    @Override
    public void onDeleted(Context context, int[] widgetIds) {
        for (int widgetId : widgetIds) WidgetStore.forgetWidget(context, widgetId);
    }
}
