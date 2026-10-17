package org.lifeboard.app.widgets;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * What the widgets read and write, in shared preferences. The snapshot is written by the app
 * (src/app/widgets.ts through capacitor-widget-bridge); the widgets only read it. The Lists
 * widget also keeps a queue of ticks for the app to apply, and which list each widget shows.
 * The file name and keys must match src/app/widgets.ts.
 */
final class WidgetStore {

    private static final String FILE = "lifeboard_widgets";
    private static final String SNAPSHOT = "snapshot";
    private static final String TICKS = "ticks";
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

    /** Ticks queued on the Lists widget and not applied by the app yet: item id → done. */
    static JSONObject ticks(Context context) {
        try {
            return new JSONObject(prefs(context).getString(TICKS, "{}"));
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    /** Queues a tick (or an untick) for the app to apply the next time it runs. */
    static void queueTick(Context context, String itemId, boolean done) {
        JSONObject ticks = ticks(context);
        try {
            ticks.put(itemId, done);
        } catch (JSONException e) {
            return;
        }
        prefs(context).edit().putString(TICKS, ticks.toString()).apply();
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
