package org.lifeboard.app.widgets;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import org.json.JSONObject;

/**
 * Today's tasks and events, then upcoming events: the snapshot's "calendar" part. Tapping one
 * of today's tasks crosses it out (or back) at once and queues the tick for the app, like the
 * Lists widget; tapping any other row opens the app. Both go through CalendarTapActivity.
 */
public class CalendarWidget extends RowsWidget {

    @Override
    String key() {
        return "calendar";
    }

    @Override
    JSONObject content(Context context, int widgetId) {
        JSONObject content = super.content(context, widgetId);
        if (content == null) return null;
        return withQueuedTicks(content, WidgetStore.ticks(context, WidgetStore.TASK_TICKS));
    }

    @Override
    Intent rowFillIn(JSONObject row, String widgetLink) {
        if (!row.has("itemId")) return super.rowFillIn(row, widgetLink);
        return new Intent()
            .putExtra(CalendarTapActivity.EXTRA_TASK, row.optString("itemId"))
            .putExtra(CalendarTapActivity.EXTRA_DONE, !row.optBoolean("done", false));
    }

    /**
     * One collection has one tap template, and event rows must still open the app, so every
     * row tap starts the invisible CalendarTapActivity, which either queues a tick or opens the
     * app. (A broadcast can't reliably open the app: Android limits starting activities from
     * the background.)
     */
    @Override
    PendingIntent rowTemplate(Context context, int widgetId) {
        Intent intent = new Intent(context, CalendarTapActivity.class);
        return PendingIntent.getActivity(context, widgetId, intent, PendingIntent.FLAG_UPDATE_CURRENT | mutable());
    }
}
