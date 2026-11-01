// Voxel MC Launcher uninstaller.
// A small WinForms dialog asks for confirmation; "delete player data" is opt-in and off by
// default. Runs with --silent (used by QuietUninstallString) it keeps player data.
// Finally it deletes the program directory (including itself) via a detached delayed rd.
//
// Compile (x64, .NET Framework, icon):
//   csc /nologo /target:winexe /platform:anycpu /win32icon:<icon.ico> ^
//       /r:System.Windows.Forms.dll /r:System.Drawing.dll ^
//       /out:<uninstall.exe> voxel-uninstall.cs
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

class VoxelUninstall
{
    const string APP_NAME = "Voxel MC Launcher";
    const string DISPLAY_KEY = "Voxel Launcher";
    const string UNINSTALL_KEY = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Voxel Launcher";

    [STAThread]
    static int Main(string[] args)
    {
        bool silent = args.Length > 0 && args[0] == "--silent";
        bool deleteData = false;

        if (!silent)
        {
            Application.EnableVisualStyles();
            if (!AskConfirm(ref deleteData)) return 0; // cancelled
        }

        Trace("start silent=" + silent);
        try
        {
            string installDir = Path.GetDirectoryName(Application.ExecutablePath);
            Trace("installDir=" + installDir);
            KillRunningApp(installDir);
            Trace("killed app");

            DeleteShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), DISPLAY_KEY + ".lnk"));
            DeleteShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), DISPLAY_KEY + ".lnk"));
            Trace("shortcuts deleted");

            try
            {
                Registry.CurrentUser.DeleteSubKeyTree(UNINSTALL_KEY, false);
                Trace("registry deleted");
            }
            catch (Exception ex) { Trace("registry delete failed: " + ex.Message); }

            if (deleteData)
            {
                string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
                DeleteDir(Path.Combine(appData, DISPLAY_KEY));
                DeleteDir(Path.Combine(appData, ".minecraft"));
                DeleteDir(Path.Combine(appData, ".voxellauncher"));
                Trace("data deleted");
            }

            // Remove the program directory (including this exe) after a short delay, detached.
            try
            {
                string cmd = "/c ping -n 3 127.0.0.1 >nul & rd /s /q \"" + installDir + "\"";
                Trace("cmd=" + cmd);
                ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", cmd);
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                psi.CreateNoWindow = true;
                Process.Start(psi);
                Trace("cmd started");
            }
            catch (Exception ex) { Trace("cmd failed: " + ex.Message); }

            if (!silent)
                MessageBox.Show("Voxel Launcher 已卸载完毕。" + (deleteData ? "\n玩家数据已删除。" : "\n玩家数据已保留。"),
                    "卸载完成", MessageBoxButtons.OK, MessageBoxIcon.Information);
            Trace("done");
            return 0;
        }
        catch (Exception ex)
        {
            Trace("top-level exception: " + ex);
            try { File.WriteAllText(Path.Combine(Path.GetTempPath(), "voxel-uninstall-error.txt"), ex.ToString()); }
            catch { }
            MessageBox.Show("卸载时出现错误：\n" + ex.Message, "卸载失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    static void Trace(string message)
    {
        try { File.AppendAllText(Path.Combine(Path.GetTempPath(), "voxel-uninstall-trace.txt"), DateTime.Now.ToString("HH:mm:ss.fff") + " " + message + Environment.NewLine); }
        catch { }
    }

    static bool AskConfirm(ref bool deleteData)
    {
        Form form = new Form();
        form.Text = "卸载 " + APP_NAME;
        form.FormBorderStyle = FormBorderStyle.FixedDialog;
        form.MaximizeBox = false;
        form.MinimizeBox = false;
        form.StartPosition = FormStartPosition.CenterScreen;
        form.ClientSize = new Size(420, 190);

        Label label = new Label();
        label.Text = "确定要卸载 Voxel Launcher 吗？\r\n将删除程序文件和注册表卸载项，"
            + "并移除桌面/开始菜单快捷方式。\r\n\r\n"
            + "玩家数据（存档、模组、启动器配置）默认保留，"
            + "如需一并删除请勾选下方选项。";
        label.SetBounds(16, 12, 388, 100);
        form.Controls.Add(label);

        CheckBox dataBox = new CheckBox();
        dataBox.Text = "同时删除玩家数据（存档、模组、启动器配置）";
        dataBox.SetBounds(16, 118, 388, 24);
        form.Controls.Add(dataBox);

        Button ok = new Button();
        ok.Text = "卸载";
        ok.SetBounds(206, 150, 90, 28);
        ok.DialogResult = DialogResult.OK;
        form.Controls.Add(ok);

        Button cancel = new Button();
        cancel.Text = "取消";
        cancel.SetBounds(304, 150, 90, 28);
        cancel.DialogResult = DialogResult.Cancel;
        form.Controls.Add(cancel);

        form.AcceptButton = ok;
        form.CancelButton = cancel;
        if (form.ShowDialog() != DialogResult.OK) return false;
        deleteData = dataBox.Checked;
        return true;
    }

    static void KillRunningApp(string installDir)
    {
        try
        {
            foreach (Process p in Process.GetProcesses())
            {
                try
                {
                    // Reading MainModule on every process is slow and can hang on system processes;
                    // the launcher's own exe name is "Voxel Launcher" (renderer/GPU children keep
                    // the same name), so filter by name first.
                    if (!string.Equals(p.ProcessName, "Voxel Launcher", StringComparison.OrdinalIgnoreCase))
                        continue;
                    string path = p.MainModule.FileName;
                    if (!string.IsNullOrEmpty(path) &&
                        path.StartsWith(installDir, StringComparison.OrdinalIgnoreCase))
                    {
                        try { p.Kill(); p.WaitForExit(3000); }
                        catch { }
                    }
                }
                catch { }
            }
        }
        catch { }
    }

    static void DeleteShortcut(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); }
        catch { }
    }

    static void DeleteDir(string dir)
    {
        try
        {
            if (Directory.Exists(dir))
            {
                Directory.Delete(dir, true);
            }
        }
        catch { }
    }
}
