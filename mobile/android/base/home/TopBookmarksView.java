/* -*- Mode: Java; c-basic-offset: 4; tab-width: 20; indent-tabs-mode: nil; -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.gecko.home;

import org.mozilla.gecko.R;
import org.mozilla.gecko.ThumbnailHelper;
import org.mozilla.gecko.db.BrowserDB.TopSitesCursorWrapper;
import org.mozilla.gecko.db.BrowserDB.URLColumns;
import org.mozilla.gecko.home.HomePager.OnUrlOpenListener;

import android.content.Context;
import android.content.res.TypedArray;
import android.database.Cursor;
import android.text.TextUtils;
import android.util.AttributeSet;
import android.view.ContextMenu.ContextMenuInfo;
import android.view.View;
import android.view.animation.AnimationUtils;
import android.view.animation.GridLayoutAnimationController;
import android.widget.AbsListView;
import android.widget.AdapterView;
import android.widget.GridView;

import java.util.EnumSet;

/**
 * A grid view of top bookmarks and pinned tabs.
 * Each cell in the grid is a TopBookmarkItemView.
 */
public class TopBookmarksView extends GridView {
    private static final String LOGTAG = "GeckoTopBookmarksView";

    // Listener for pinning bookmarks.
    public static interface OnPinBookmarkListener {
        public void onPinBookmark(int position);
    }

    // Max number of bookmarks that needs to be shown.
    private final int mMaxBookmarks;

    // Number of columns to show.
    private final int mNumColumns;

    // Horizontal spacing in between the rows.
    private final int mHorizontalSpacing;

    // Vertical spacing in between the rows.
    private final int mVerticalSpacing;

    // On URL open listener.
    private OnUrlOpenListener mUrlOpenListener;

    // Pin bookmark listener.
    private OnPinBookmarkListener mPinBookmarkListener;

    // Context menu info.
    private TopBookmarksContextMenuInfo mContextMenuInfo;

    public TopBookmarksView(Context context) {
        this(context, null);
    }

    public TopBookmarksView(Context context, AttributeSet attrs) {
        this(context, attrs, R.attr.topBookmarksViewStyle);
    }

    public TopBookmarksView(Context context, AttributeSet attrs, int defStyle) {
        super(context, attrs, defStyle);
        mMaxBookmarks = getResources().getInteger(R.integer.number_of_top_sites);
        mNumColumns = getResources().getInteger(R.integer.number_of_top_sites_cols);
        setNumColumns(mNumColumns);

        TypedArray a = context.obtainStyledAttributes(attrs, R.styleable.TopBookmarksView, defStyle, 0);
        mHorizontalSpacing = a.getDimensionPixelOffset(R.styleable.TopBookmarksView_android_horizontalSpacing, 0x00);
        mVerticalSpacing = a.getDimensionPixelOffset(R.styleable.TopBookmarksView_android_verticalSpacing, 0x00);
        a.recycle();
    }

    /**
     * {@inheritDoc}
     */
    @Override
    public void onAttachedToWindow() {
        super.onAttachedToWindow();

        setOnItemClickListener(new AdapterView.OnItemClickListener() {
            @Override
            public void onItemClick(AdapterView<?> parent, View view, int position, long id) {
                TopBookmarkItemView row = (TopBookmarkItemView) view;
                String url = row.getUrl();

                // If the url is empty, the user can pin a bookmark.
                // If not, navigate to the page given by the url.
                if (!TextUtils.isEmpty(url)) {
                    if (mUrlOpenListener != null) {
                        mUrlOpenListener.onUrlOpen(url, EnumSet.noneOf(OnUrlOpenListener.Flags.class));
                    }
                } else {
                    if (mPinBookmarkListener != null) {
                        mPinBookmarkListener.onPinBookmark(position);
                    }
                }
            }
        });

        setOnItemLongClickListener(new AdapterView.OnItemLongClickListener() {
            @Override
            public boolean onItemLongClick(AdapterView<?> parent, View view, int position, long id) {
                Cursor cursor = (Cursor) parent.getItemAtPosition(position);
                mContextMenuInfo = new TopBookmarksContextMenuInfo(view, position, id, cursor);
                return showContextMenuForChild(TopBookmarksView.this);
            }
        });

        final GridLayoutAnimationController controller = new GridLayoutAnimationController(AnimationUtils.loadAnimation(getContext(), R.anim.grow_fade_in_center));
        setLayoutAnimation(controller);
    }

    @Override
    public void onDetachedFromWindow() {
        super.onDetachedFromWindow();

        mUrlOpenListener = null;
        mPinBookmarkListener = null;
    }

    /**
     * {@inheritDoc}
     */
    @Override
    public int getColumnWidth() {
        // This method will be called from onMeasure() too.
        // It's better to use getMeasuredWidth(), as it is safe in this case.
        final int totalHorizontalSpacing = mNumColumns > 0 ? (mNumColumns - 1) * mHorizontalSpacing : 0;
        return (getMeasuredWidth() - getPaddingLeft() - getPaddingRight() - totalHorizontalSpacing) / mNumColumns;
    }

    /**
     * {@inheritDoc}
     */
    @Override
    protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
        // Sets the padding for this view.
        super.onMeasure(widthMeasureSpec, heightMeasureSpec);

        final int measuredWidth = getMeasuredWidth();
        final int childWidth = getColumnWidth();
        int childHeight = 0;

        // Set the column width as the thumbnail width.
        ThumbnailHelper.getInstance().setThumbnailWidth(childWidth);

        // If there's an adapter, use it to calculate the height of this view.
        final TopBookmarksAdapter adapter = (TopBookmarksAdapter) getAdapter();
        final int count;

        // There shouldn't be any inherent size (due to padding) if there are no child views.
        if (adapter == null || (count = adapter.getCount()) == 0) {
            setMeasuredDimension(0, 0);
            return;
        }

        // Get the first child from the adapter.
        final View child = adapter.getView(0, null, this);
        if (child != null) {
            // Set a default LayoutParams on the child, if it doesn't have one on its own.
            AbsListView.LayoutParams params = (AbsListView.LayoutParams) child.getLayoutParams();
            if (params == null) {
                params = new AbsListView.LayoutParams(AbsListView.LayoutParams.WRAP_CONTENT,
                                                      AbsListView.LayoutParams.WRAP_CONTENT);
                child.setLayoutParams(params);
            }

            // Measure the exact width of the child, and the height based on the width.
            // Note: the child (and BookmarkThumbnailView) takes care of calculating its height.
            int childWidthSpec = MeasureSpec.makeMeasureSpec(childWidth, MeasureSpec.EXACTLY);
            int childHeightSpec = MeasureSpec.makeMeasureSpec(0,  MeasureSpec.UNSPECIFIED);
            child.measure(childWidthSpec, childHeightSpec);
            childHeight = child.getMeasuredHeight();
        }

        // Find the minimum of bookmarks we need to show, and the one given by the cursor.
        final int total = Math.min(count > 0 ? count : Integer.MAX_VALUE, mMaxBookmarks);

        // Number of rows required to show these bookmarks.
        final int rows = (int) Math.ceil((double) total / mNumColumns);
        final int childrenHeight = childHeight * rows;
        final int totalVerticalSpacing = rows > 0 ? (rows - 1) * mVerticalSpacing : 0;

        // Total height of this view.
        final int measuredHeight = childrenHeight + getPaddingTop() + getPaddingBottom() + totalVerticalSpacing;
        setMeasuredDimension(measuredWidth, measuredHeight);
    }

    @Override
    public ContextMenuInfo getContextMenuInfo() {
        return mContextMenuInfo;
    }

    /**
     * Set an url open listener to be used by this view.
     *
     * @param listener An url open listener for this view.
     */
    public void setOnUrlOpenListener(OnUrlOpenListener listener) {
        mUrlOpenListener = listener;
    }

    /**
     * Set a pin bookmark listener to be used by this view.
     *
     * @param listener A pin bookmark listener for this view.
     */
    public void setOnPinBookmarkListener(OnPinBookmarkListener listener) {
        mPinBookmarkListener = listener;
    }

    /**
     * A ContextMenuInfo for TopBoomarksView that adds details from the cursor.
     */
    public static class TopBookmarksContextMenuInfo extends AdapterContextMenuInfo {

        // URL to Title replacement regex.
        private static final String REGEX_URL_TO_TITLE = "^([a-z]+://)?(www\\.)?";

        public String url;
        public String title;
        public boolean isPinned;

        public TopBookmarksContextMenuInfo(View targetView, int position, long id, Cursor cursor) {
            super(targetView, position, id);

            if (cursor == null) {
                return;
            }

            url = cursor.getString(cursor.getColumnIndexOrThrow(URLColumns.URL));
            title = cursor.getString(cursor.getColumnIndexOrThrow(URLColumns.TITLE));
            isPinned = ((TopSitesCursorWrapper) cursor).isPinned();
        }

        public String getDisplayTitle() {
            return TextUtils.isEmpty(title) ? url.replaceAll(REGEX_URL_TO_TITLE, "") : title;
        }
    }
}
