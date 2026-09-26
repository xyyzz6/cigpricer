package com.boki.cigpricer;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * 极简 FileProvider（应用内更新用，2026-09-26，移植自 douyin-nas）。
 *
 * <h3>为什么不用 androidx.core 的 FileProvider</h3>
 * 本项目没有 Gradle，第三方库全靠手工铺开；为这一个类引入整个 androidx.core 不值当。
 *
 * <h3>它解决什么问题</h3>
 * Android 8.0+ 起，App 不能把 file:// 路径交给别的 App（系统安装器），会抛
 * FileUriExposedException 直接崩。必须发一个 content:// Uri，并只在这一条 Intent 上授权读。
 *
 * <h3>🔴 安全边界</h3>
 * openFile() 里只放行 cacheDir/update 内的文件；用 getCanonicalPath() 前缀比对挡掉 .. 穿越。
 * authorities 必须与 AndroidManifest 的 <provider> 和 MainActivity 调用处三处一致。
 */
public class UpdateProvider extends ContentProvider {

    public static final String AUTHORITY = "com.boki.cigpricer.update";

    @Override
    public boolean onCreate() {
        return true;
    }

    private File resolve(Uri uri) throws FileNotFoundException {
        if (!AUTHORITY.equals(uri.getAuthority())) return null;
        File root = getRoot();
        String rel = uri.getPath() == null ? "" : uri.getPath().replaceFirst("^/+", "");
        File f = new File(root, rel);
        try {
            String rootPath = root.getCanonicalPath();
            String filePath = f.getCanonicalPath();
            if (!filePath.equals(rootPath) && !filePath.startsWith(rootPath + File.separator)) {
                throw new FileNotFoundException("越界访问被拒绝：" + uri);
            }
        } catch (java.io.IOException e) {
            throw new FileNotFoundException("路径解析失败：" + e.getMessage());
        }
        if (!f.exists()) throw new FileNotFoundException("文件不存在：" + f.getName());
        return f;
    }

    private File getRoot() {
        File dir = new File(getContext().getCacheDir(), "update");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        File f = resolve(uri);
        if (f == null) throw new FileNotFoundException("不是本 provider 的 Uri：" + uri);
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection,
                       String[] selectionArgs, String sortOrder) {
        File f;
        try {
            f = resolve(uri);
        } catch (FileNotFoundException e) {
            return null;
        }
        if (f == null) return null;
        String[] cols = projection != null ? projection
                : new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
        MatrixCursor cur = new MatrixCursor(cols, 1);
        MatrixCursor.RowBuilder row = cur.newRow();
        for (String c : cols) {
            if (OpenableColumns.DISPLAY_NAME.equals(c)) row.add(f.getName());
            else if (OpenableColumns.SIZE.equals(c)) row.add(f.length());
            else row.add(null);
        }
        return cur;
    }

    @Override
    public String getType(Uri uri) {
        String ext = MimeTypeMap.getFileExtensionFromUrl(uri.toString());
        String mime = ext == null ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.toLowerCase());
        return mime != null ? mime : "application/octet-stream";
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException("只读 provider");
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("只读 provider");
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("只读 provider");
    }
}
