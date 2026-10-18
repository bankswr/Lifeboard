package org.lifeboard.app.widgets;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * What the widgets read and write, in shared preferences. The snapshot is written by the app
 * (src/app/widgets.ts through capacitor-widget-bridge); the widgets only read it. The widgets
 * also keep queues of changes for the app to apply (list ticks, items added on the Lists
 * widget, task ticks on the Calendar widget), and which list each Lists widget shows.
 * The file name and keys must match src/app/widgets.ts.
 */
final class WidgetStore {

    private static final String FILE = "lifeboard_widgets";
    private static final String SNAPSHOT = "snapshot";
    /** Lists widget ticks: item id → done. */
    static final String LIST_TICKS = "ticks";
    /** Calendar widget ticks: task id → done. */
    static final String TASK_TICKS = "taskTicks";
    /** Items added on the Lists widget: [{listId, text}]. */
    private static final String ADDS = "adds";
    private static final String LIST_PREFIX = "list_";

    private WidgetStore() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    /** The app's latest snapshot, or null before the app has run once. */
    static JSONObject snapshot(Context context) {
        String json = prefs(context).getString(SNAPSHOT, null);
        if (json == null) return null;
        try {
            return new JSONObject(json);
        } catch (JSONException e) {
            return null;
        }
    }

    /** Ticks queued under `key` (LIST_TICKS or TASK_TICKS) and not applied by the app yet: id → done. */
    static JSONObject ticks(Context context, String key) {
        try {
            return new JSONObject(prefs(context).getString(key, "{}"));
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    /** Queues a tick (or an untick) for the app to apply the next time it runs. */
    static void queueTick(Context context, String key, String id, boolean done) {
        JSONObject ticks = ticks(context, key);
        try {
            ticks.put(id, done);
        } catch (JSONException e) {
            return;
        }
        prefs(context).edit().putString(key, ticks.toString()).apply();
    }

    /** Items added on the Lists widget and not applied by the app yet. */
    static JSONArray adds(Context context) {
        try {
            return new JSONArray(prefs(context).getString(ADDS, "[]"));
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    /** Queues a new item for the app to add to the list the next time it runs. */
    static void queueAdd(Context context, String listId, String text) {
        JSONArray adds = adds(context);
        try {
            adds.put(new JSONObject().put("listId", listId).put("text", text));
        } catch (JSONException e) {
            return;
        }
        prefs(context).edit().putString(ADDS, adds.toString()).apply();
    }

    static String listFor(Context context, int widgetId) {
        return prefs(context).getString(LIST_PREFIX + widgetId, null);
    }

    static void setListFor(Context context, int widgetId, String listId) {
        prefs(context).edit().putString(LIST_PREFIX + widgetId, listId).apply();
    }

    static void forgetWidget(Context context, int widgetId) {
        prefs(context).edit().remove(LIST_PREFIX + widgetId).apply();
    }
}
