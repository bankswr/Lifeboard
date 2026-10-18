package org.lifeboard.app.widgets;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.text.SpannableString;
import android.text.Spanned;
import android.text.style.StrikethroughSpan;
import android.util.TypedValue;
import android.view.View;
import android.widget.RemoteViews;
import androidx.core.widget.RemoteViewsCompat;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.lifeboard.app.R;

/**
 * A home-screen widget that draws one part of the app's snapshot (src/core/widgets.ts) as a
 * header and a scrolling list of rows. It decides nothing: every row's text and style come
 * from the snapshot. Tapping the header or a row opens the matching page in the app; the
 * Lists and Calendar widgets tick rows instead (their own classes).
 */
public abstract class RowsWidget extends AppWidgetProvider {

    /** The app theme's colors (src/app/style.css), matched by hand. */
    static final int TEXT = Color.parseColor("#f8fafc");
    static final int MUTED = Color.parseColor("#94a3b8");
    static final int ACCENT = Color.parseColor("#22c55e");
    static final int DANGER = Color.parseColor("#f87171");
    static final int WARNING = Color.parseColor("#facc15");

    /** The snapshot's key for this widget ("health", "calendar", ...). */
    abstract String key();

    /** This widget's content, or null when there's nothing to show yet. */
    JSONObject content(Context context, int widgetId) {
        JSONObject snapshot = WidgetStore.snapshot(context);
        return snapshot == null ? null : snapshot.optJSONObject(key());
    }

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] widgetIds) {
        for (int widgetId : widgetIds) draw(context, manager, widgetId);
    }

    void draw(Context context, AppWidgetManager manager, int widgetId) {
        JSONObject snapshot = WidgetStore.snapshot(context);
        JSONObject content = content(context, widgetId);
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_rows);
        String link = content == null ? "monitor" : content.optString("link", "monitor");

        views.setTextViewText(R.id.widget_title, content == null ? "Lifeboard" : content.optString("title"));
        views.setTextViewText(R.id.widget_taken, snapshot == null ? "" : snapshot.optString("takenLabel"));
        views.setOnClickPendingIntent(R.id.widget_header, openApp(context, link, widgetId));
        views.setPendingIntentTemplate(R.id.widget_rows, rowTemplate(context, widgetId));
        if (content != null) decorateHeader(context, views, widgetId, content);

        JSONArray rows = content == null ? null : content.optJSONArray("rows");
        int count = rows == null ? 0 : rows.length();
        RemoteViewsCompat.RemoteCollectionItems.Builder items = new RemoteViewsCompat.RemoteCollectionItems.Builder();
        for (int i = 0; i < count; i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row != null) items.addItem(i, rowView(context, row, link));
        }
        items.setViewTypeCount(1);
        RemoteViewsCompat.setRemoteAdapter(context, views, widgetId, R.id.widget_rows, items.build());

        views.setTextViewText(R.id.widget_empty, content == null ? "Open Lifeboard once to fill this widget." : content.optString("empty"));
        views.setViewVisibility(R.id.widget_empty, count == 0 ? View.VISIBLE : View.GONE);
        manager.updateAppWidget(widgetId, views);
    }

    /** Extra header controls; the Lists widget shows its add button here. None by default. */
    void decorateHeader(Context context, RemoteViews views, int widgetId, JSONObject content) {}

    /** One row: title (struck through when done), an optional second line and a right-hand value. */
    RemoteViews rowView(Context context, JSONObject row, String widgetLink) {
        RemoteViews view = new RemoteViews(context.getPackageName(), R.layout.widget_row);
        String style = row.optString("style", "normal");
        boolean done = row.optBoolean("done", false);
        boolean header = style.equals("header");

        CharSequence title = row.optString("title");
        if (done) {
            SpannableString struck = new SpannableString(title);
            struck.setSpan(new StrikethroughSpan(), 0, struck.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            title = struck;
        }
        view.setTextViewText(R.id.row_title, title);
        view.setTextColor(R.id.row_title, done ? MUTED : colorFor(style));
        view.setTextViewTextSize(R.id.row_title, TypedValue.COMPLEX_UNIT_SP, header ? 13 : 14);

        String sub = row.optString("sub", "");
        view.setTextViewText(R.id.row_sub, sub);
        view.setViewVisibility(R.id.row_sub, sub.isEmpty() ? View.GONE : View.VISIBLE);

        String value = row.optString("value", "");
        view.setTextViewText(R.id.row_value, value);
        boolean flagged = style.equals("alarm") || style.equals("warning");
        view.setTextColor(R.id.row_value, flagged ? colorFor(style) : MUTED);
        view.setViewVisibility(R.id.row_value, value.isEmpty() ? View.GONE : View.VISIBLE);

        boolean tickable = row.has("itemId");
        view.setViewVisibility(R.id.row_check, tickable ? View.VISIBLE : View.GONE);
        if (tickable) {
            view.setTextViewText(R.id.row_check, done ? "☑" : "☐");
            view.setTextColor(R.id.row_check, done ? ACCENT : MUTED);
        }
        view.setOnClickFillInIntent(R.id.row_root, rowFillIn(row, widgetLink));
        return view;
    }

    static int colorFor(String style) {
        switch (style) {
            case "header":
            case "good":
                return ACCENT;
            case "muted":
                return MUTED;
            case "warning":
                return WARNING;
            case "alarm":
                return DANGER;
            default:
                return TEXT;
        }
    }

    /** What a row tap adds to the template: the page to open. The Lists widget ticks instead. */
    Intent rowFillIn(JSONObject row, String widgetLink) {
        return new Intent().setData(Uri.parse("lifeboard://open/" + row.optString("link", widgetLink)));
    }

    /** The intent row taps fill in: by default, opening the app at the row's page. */
    PendingIntent rowTemplate(Context context, int widgetId) {
        Intent intent = new Intent(Intent.ACTION_VIEW).setPackage(context.getPackageName());
        return PendingIntent.getActivity(context, widgetId, intent, PendingIntent.FLAG_UPDATE_CURRENT | mutable());
    }

    /**
     * Shows ticks queued on the widget (id → done) on the rows they belong to, so a tap shows
     * at once, before the app has applied it. Changes `content` in place and returns it.
     */
    static JSONObject withQueuedTicks(JSONObject content, JSONObject ticks) {
        JSONArray rows = content.optJSONArray("rows");
        if (rows == null || ticks.length() == 0) return content;
        try {
            for (int i = 0; i < rows.length(); i++) {
                JSONObject row = rows.getJSONObject(i);
                String id = row.optString("itemId");
                if (ticks.has(id)) row.put("done", ticks.getBoolean(id));
            }
        } catch (JSONException e) {
            // A malformed row is drawn as the snapshot had it.
        }
        return content;
    }

    /** Redraws every placed widget of this kind, e.g. after a tick was queued. */
    static void redrawAll(Context context, RowsWidget widget) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        for (int widgetId : manager.getAppWidgetIds(new ComponentName(context, widget.getClass()))) {
            widget.draw(context, manager, widgetId);
        }
    }

    static PendingIntent openApp(Context context, String link, int widgetId) {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse("lifeboard://open/" + link)).setPackage(context.getPackageName());
        return PendingIntent.getActivity(context, 10_000 + widgetId, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** Row templates are filled in per row, which Android 12+ allows only for mutable intents. */
    static int mutable() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0;
    }
}
