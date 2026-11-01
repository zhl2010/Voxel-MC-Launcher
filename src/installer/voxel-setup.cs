// Voxel MC Launcher single-file installer stub.
// Layout of the shipped setup executable:
//   [this stub] [data.zip] [24-byte footer: "VXLSZIP!"(8) + int64 zipStart + int64 zipLen]
// The stub also embeds uninstall.exe as a managed resource and writes it into the install
// directory, and registers a standard HKCU uninstall entry pointing at it.
//
// Compile (x64, .NET Framework, icon + embedded uninstaller):
//   csc /nologo /target:winexe /platform:anycpu /win32icon:<icon.ico> ^
//       /resource:<uninstall.exe>,uninstall.exe ^
//       /r:System.IO.Compression.dll ^
//       /out:<voxel-setup.exe> voxel-setup.cs
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;

class VoxelSetup
{
    const string MAGIC = "VXLSZIP!";
    const string APP_NAME = "Voxel MC Launcher";
    const string DISPLAY_KEY = "Voxel Launcher";
    const string PUBLISHER = "zhl2010";
    const string VERSION = "1.2.0";
    const string UNINSTALL_KEY = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Voxel Launcher";

    static string LogFile = Path.Combine(Path.GetTempPath(), "voxel-install-progress.log");

    static void Log(string message)
    {
        try { File.AppendAllText(LogFile, DateTime.Now.ToString("HH:mm:ss") + " " + message + Environment.NewLine); }
        catch { }
        Console.WriteLine(message);
    }

    static int Main(string[] args)
    {
        try
        {
            string self = Process.GetCurrentProcess().MainModule.FileName;
            byte[] data = File.ReadAllBytes(self);
            if (data.Length < 24 ||
                Encoding.ASCII.GetString(data, data.Length - 24, 8) != MAGIC)
            {
                Log("footer magic mismatch");
                return 1;
            }
            long zipStart = BitConverter.ToInt64(data, data.Length - 16);
            long zipLen = BitConverter.ToInt64(data, data.Length - 8);
            if (zipStart < 0 || zipLen < 0 || zipStart + zipLen > data.Length - 24)
            {
                Log("footer bounds invalid: start=" + zipStart + " len=" + zipLen + " file=" + data.Length);
                return 1;
            }

            if (args.Length > 0 && args[0] == "--selftest")
            {
                using (MemoryStream ms = new MemoryStream(data, (int)zipStart, (int)zipLen, false))
                using (ZipArchive zip = new ZipArchive(ms, ZipArchiveMode.Read))
                {
                    Log("DONE zip entries=" + zip.Entries.Count + " start=" + zipStart + " len=" + zipLen);
                }
                return 0;
            }

            string targetDir = DefaultTargetDir();
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--dir" && i + 1 < args.Length)
                    targetDir = Path.GetFullPath(args[i + 1]);
            }
            Log("install target: " + targetDir);

            Directory.CreateDirectory(targetDir);
            using (MemoryStream ms = new MemoryStream(data, (int)zipStart, (int)zipLen, false))
            using (ZipArchive zip = new ZipArchive(ms, ZipArchiveMode.Read))
            {
                int count = 0;
                foreach (ZipArchiveEntry entry in zip.Entries)
                {
                    string rel = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                    string outPath = Path.Combine(targetDir, rel);
                    if (entry.FullName.EndsWith("/"))
                    {
                        Directory.CreateDirectory(outPath);
                        continue;
                    }
                    Directory.CreateDirectory(Path.GetDirectoryName(outPath));
                    entry.ExtractToFile(outPath, true);
                    count++;
                }
                Log("extracted " + count + " files");
            }

            // Embed uninstall.exe (managed resource named "uninstall.exe").
            string uninstallPath = Path.Combine(targetDir, "uninstall.exe");
            using (Stream res = Assembly.GetExecutingAssembly().GetManifestResourceStream("uninstall.exe"))
            {
                if (res == null) Log("WARN embedded uninstall.exe resource missing");
                else
                {
                    using (FileStream f = File.Create(uninstallPath)) res.CopyTo(f);
                    Log("uninstaller written: " + uninstallPath);
                }
            }

            string appExe = Path.Combine(targetDir, "Voxel Launcher.exe");
            CreateShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), DISPLAY_KEY + ".lnk"), appExe, targetDir);
            CreateShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), DISPLAY_KEY + ".lnk"), appExe, targetDir);
            Log("shortcuts created");

            using (Microsoft.Win32.RegistryKey key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(UNINSTALL_KEY))
            {
                key.SetValue("DisplayName", APP_NAME);
                key.SetValue("DisplayVersion", VERSION);
                key.SetValue("Publisher", PUBLISHER);
                key.SetValue("InstallLocation", targetDir);
                key.SetValue("DisplayIcon", appExe);
                key.SetValue("UninstallString", "\"" + uninstallPath + "\"");
                key.SetValue("QuietUninstallString", "\"" + uninstallPath + "\" --silent");
                key.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
                key.SetValue("NoModify", 1);
                key.SetValue("NoRepair", 1);
            }
            Log("registry uninstall entry written");
            Log("DONE installed to " + targetDir);
            return 0;
        }
        catch (Exception ex)
        {
            try { File.WriteAllText(Path.Combine(Path.GetTempPath(), "voxel-setup-error.txt"), ex.ToString()); }
            catch { }
            Console.Error.WriteLine("EXCEPTION: " + ex.Message);
            return 1;
        }
    }

    static string DefaultTargetDir()
    {
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        return Path.Combine(local, "Programs", DISPLAY_KEY);
    }

    static void CreateShortcut(string lnkPath, string target, string workDir)
    {
        try
        {
            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType == null) return;
            object shell = Activator.CreateInstance(shellType);
            object shortcut = shellType.InvokeMember("CreateShortcut",
                BindingFlags.InvokeMethod, null, shell, new object[] { lnkPath });
            shortcut.GetType().InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { target });
            shortcut.GetType().InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { workDir });
            shortcut.GetType().InvokeMember("IconLocation", BindingFlags.SetProperty, null, shortcut, new object[] { target + ",0" });
            shortcut.GetType().InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
        }
        catch (Exception ex)
        {
            Log("WARN shortcut failed " + lnkPath + ": " + ex.Message);
        }
    }
}
