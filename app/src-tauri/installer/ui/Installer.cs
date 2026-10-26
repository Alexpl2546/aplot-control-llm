// WPF presentation for the existing NSIS / native component protocols. No second installer engine.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Microsoft.Win32;

[assembly: System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.8", FrameworkDisplayName=".NET Framework 4.8")]

namespace AplotInstaller {
  internal sealed class ProgressInfo {
    public string stage {get;set;}
    public string title {get;set;}
    public string detail {get;set;}
    public double? percent {get;set;}
    public double? downloaded {get;set;}
    public double? total {get;set;}
    public double? rate {get;set;}
  }
  internal sealed class Installation {
    public string Directory, Version;
    public bool Registered, Machine;
  }
  internal static class Policy {
    public static string Quote(string value) {
      var result = new StringBuilder("\""); int slashes = 0;
      foreach (char c in value) {
        if (c == '\\') { slashes++; continue; }
        result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes); slashes = 0; result.Append(c);
      }
      return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    public static Version VersionOf(string value) {
      Version parsed;
      return Version.TryParse((value ?? "").TrimStart('v').Split('-')[0], out parsed) ? new Version(parsed.Major,parsed.Minor,Math.Max(0,parsed.Build),Math.Max(0,parsed.Revision)) : new Version(0,0,0,0);
    }
    public static bool CanUpdate(Installation found, string incoming) {
      return found == null || (!found.Machine && VersionOf(found.Version) <= VersionOf(incoming));
    }
    public static string AppDirectory(string path) {
      if (String.IsNullOrWhiteSpace(path) || !Path.IsPathRooted(path)) throw new Exception("Укажите полный путь к папке приложения.");
      string full = Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar);
      if (full.Length <= Path.GetPathRoot(full).TrimEnd(Path.DirectorySeparatorChar).Length || File.Exists(full))
        throw new Exception("Выберите отдельную папку для Aplot, а не корень диска или файл.");
      return full;
    }
    public static string Arguments(IEnumerable<string> values) {
      var parts=values.ToArray();
      Func<string,string> encode=value=>new []{"/S","/P","/UPDATE","/CLASSIC","/DELETE_APP_DATA=1","/SHORTCUTS=none","/SHORTCUTS=desktop","/SHORTCUTS=startmenu","/SHORTCUTS=both"}.Contains(value)?value:Quote(value);
      // NSIS requires /D= to be last and unquoted, including directories with spaces.
      if(parts.Length>0&&parts[parts.Length-1].StartsWith("/D=",StringComparison.Ordinal))
        return String.Join(" ",parts.Take(parts.Length-1).Select(encode))+" "+parts[parts.Length-1];
      return String.Join(" ",parts.Select(encode));
    }
    public static bool PythonAllowed(IEnumerable<string> owned, ICollection<string> selected) {
      return !owned.Any(id => (id == "strata" || id == "hermes") && !selected.Contains(id));
    }
    public static int PreviousPage(int page,bool choices) { return page==2 ? choices?1:0 : Math.Max(0,page-1); }
    public static string DefaultDirectory() { return Path.Combine(Path.GetPathRoot(Environment.SystemDirectory),"Aplot Control LLM"); }
    public static string[] InstallArguments(string directory,bool desktop,bool startMenu) {
      return new [] {"/S","/SHORTCUTS="+(desktop?startMenu?"both":"desktop":startMenu?"startmenu":"none"),"/D="+directory};
    }
    public static ProgressInfo ReadProgress(string line) {
      if(line==null||!line.StartsWith("APLOT_PROGRESS ",StringComparison.Ordinal))return null;
      try {
        var value=new JavaScriptSerializer().Deserialize<ProgressInfo>(line.Substring(15));
        if(value==null||String.IsNullOrWhiteSpace(value.title))return null;
        if(value.percent.HasValue&&(Double.IsNaN(value.percent.Value)||Double.IsInfinity(value.percent.Value)||value.percent<0||value.percent>100))value.percent=null;
        return value;
      }catch{return null;}
    }
  }
  internal sealed class Wizard {
    private readonly Window window;
    private readonly Dictionary<string,string> args;
    private readonly Dictionary<string,object> catalog;
    private readonly Dictionary<string,object> build;
    private readonly Dictionary<string,object> licenses;
    private readonly Dictionary<string,Dictionary<string,object>> owned = new Dictionary<string,Dictionary<string,object>>();
    private readonly HashSet<string> existing = new HashSet<string>();
    private readonly Dictionary<string,string> existingPaths = new Dictionary<string,string>();
    private readonly HashSet<string> addSelection = new HashSet<string>();
    private readonly HashSet<string> removeSelection = new HashSet<string>();
    private readonly HashSet<string> withoutDependencies = new HashSet<string>();
    private readonly List<string> outcomes = new List<string>();
    private readonly List<string> failures = new List<string>();
    private readonly string work, assets, probe, version;
    private readonly bool maintenance, preview;
    private Installation found;
    private int page;
    private bool busy, cancelRequested, initializing = true, shellSucceeded;
    private string directory, technicalLog;
    private readonly Stopwatch operationClock=new Stopwatch(),stageClock=new Stopwatch();
    private readonly DispatcherTimer progressTimer;
    private string currentStage="";
    private const string AppFolderName="Aplot Control LLM";
    private int totalUnits,processedUnits;
    public int ExitCode;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 20 * 1024 * 1024 };
    private static readonly Brush Lime = new SolidColorBrush(Color.FromRgb(200,242,124));
    private static readonly Brush Muted = new SolidColorBrush(Color.FromRgb(172,182,193));
    public Wizard(Dictionary<string,string> options) {
      args = options; maintenance = args.ContainsKey("maintenance"); preview = args.ContainsKey("preview");
      catalog = ReadResourceJson("components.json"); build = ReadResourceJson("build.json"); version = Str(build,"version");
      licenses = ReadResourceJson("licenses.json");
      work = Path.Combine(Path.GetTempPath(), "aplot-wizard-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(work);
      technicalLog = Path.Combine(work,"wizard.log");
      assets = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
      probe = Get("probe", Path.Combine(Get("app-directory",Path.GetDirectoryName(assets)),"aplot-control-llm.exe"));
      using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Installer.xaml")) window = (Window)XamlReader.Load(stream);
      window.Icon = Find<Image>("BrandLogo").Source;
      progressTimer=new DispatcherTimer {Interval=TimeSpan.FromSeconds(1)};
      progressTimer.Tick+=delegate {Text("OperationElapsed","Текущий этап: "+stageClock.Elapsed.ToString(@"hh\:mm\:ss")+" · Всего: "+operationClock.Elapsed.ToString(@"hh\:mm\:ss"));};
      Text("VersionLabel", "Aplot Control LLM · " + version);
      Text("WindowSubtitle", maintenance ? "Управление приложением" : "Установка и обновление");
      if(maintenance) {Text("SidebarTitle","ОБСЛУЖИВАНИЕ APLOT");Text("SidebarHint","Приложение и модули можно удалить отдельно.\n\nПеред началом вы увидите список выбранных действий.");}
      Find<Button>("CloseButton").Click += delegate { window.Close(); };
      Find<Button>("MinimizeButton").Click += delegate { window.WindowState = WindowState.Minimized; };
      Find<System.Windows.Controls.Border>("TitleBar").MouseLeftButtonDown += delegate(object sender, MouseButtonEventArgs e) {
        DependencyObject current = e.OriginalSource as DependencyObject;
        while (current != null) { if (current is Button) return; current = VisualTreeHelper.GetParent(current); }
        if (e.ClickCount == 1) window.DragMove();
      };
      window.Closing += delegate(object sender, System.ComponentModel.CancelEventArgs e) {
        if (busy) { e.Cancel = true; cancelRequested = true; Text("OperationDetail", "Остановимся после текущего компонента. Дождитесь завершения операции."); }
      };
      Find<Button>("NextButton").Click += async delegate { await Next(); };
      Find<Button>("BackButton").Click += async delegate {
        if(busy)return;
        if(page==4) {
          if(shellSucceeded) { found=new Installation{Directory=directory,Version=version,Registered=true}; Visible("ModulesAction",true); Find<RadioButton>("ModulesAction").IsChecked=true; }
          await InspectDirectory(); Show(shellSucceeded||IsModulesOnly()||maintenance?1:0);
        } else Show(Policy.PreviousPage(page,NeedsChoices()));
      };
      Find<Button>("OpenLogButton").Click += delegate { if(File.Exists(technicalLog))Process.Start(new ProcessStartInfo("notepad.exe",Policy.Quote(technicalLog)){UseShellExecute=false}); };
      Find<Button>("ProgressLogButton").Click += delegate { if(File.Exists(technicalLog))Process.Start(new ProcessStartInfo("notepad.exe",Policy.Quote(technicalLog)){UseShellExecute=false}); };
      Find<Button>("BrowseButton").Click += async delegate {
        string initial=ParentDirectoryForPicker(Find<TextBox>("InstallDirectory").Text);
        string selected=PickInstallParent(initial);
        if (!String.IsNullOrEmpty(selected)) {
          try {
            directory=AppDirectoryForParent(selected);
            Find<TextBox>("InstallDirectory").Text=directory;
            await InspectDirectory();
          } catch(Exception error) { Error(error.Message); }
        }
      };
      Find<Button>("ReadLicensesButton").Click += delegate { OpenLicenses(); };
      foreach (string name in new [] {"ApplicationAction","ModulesAction","ExpressInstall","CustomComponents","AddModules","RemoveModules","ReuseExisting","MigrateExisting"}) {
        var toggle = Find<System.Windows.Controls.Primitives.ToggleButton>(name);
        toggle.Checked += delegate { if (!initializing && !busy) {Find<CheckBox>("AcceptLicense").IsChecked=false;RefreshChoices();} };
        toggle.Unchecked += delegate { if (!initializing && !busy) RefreshChoices(); };
      }
      Find<CheckBox>("AcceptLicense").Checked += delegate { UpdateNext(); };
      Find<CheckBox>("AcceptLicense").Unchecked += delegate { UpdateNext(); };
      Find<CheckBox>("DeleteUserData").Checked += delegate { if(page==2)Review(); };
      Find<CheckBox>("DeleteUserData").Unchecked += delegate { if(page==2)Review(); };
      window.Loaded += async delegate { await Initialize(); };
      Show(0); window.ShowDialog();
      // Temp files are diagnostic/retry evidence. NSIS owns and cleans the extracted executable directory.
    }
    private T Find<T>(string name) where T:class { return window.FindName(name) as T; }
    private void Text(string name, string value) { Find<TextBlock>(name).Text = value; }
    private void Visible(string name, bool visible) { Find<FrameworkElement>(name).Visibility = visible ? Visibility.Visible : Visibility.Collapsed; }
    private bool Checked(string name) { return Find<System.Windows.Controls.Primitives.ToggleButton>(name).IsChecked == true; }
    private string Get(string key, string fallback) { string value; return args.TryGetValue(key,out value) ? value : fallback; }
    internal static string Str(Dictionary<string,object> data, string key) { object value; return data != null && data.TryGetValue(key,out value) && value != null ? Convert.ToString(value,CultureInfo.InvariantCulture) : ""; }
    private static Dictionary<string,object> Obj(object value) { return value as Dictionary<string,object>; }
    private static object[] ArrayOf(Dictionary<string,object> data, string key) { object value; return data != null && data.TryGetValue(key,out value) && value is IEnumerable && !(value is string) ? ((IEnumerable)value).Cast<object>().ToArray() : new object[0]; }
    private static Dictionary<string,object> ReadResourceJson(string name) { using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream(name)) using(var reader=new StreamReader(stream)) return Obj(Json.DeserializeObject(reader.ReadToEnd())); }
    private static Dictionary<string,object> ReadJson(string path) { return Obj(Json.DeserializeObject(File.ReadAllText(path,Encoding.UTF8))); }
    private void Error(string message) { Text("InlineErrorText",message); Visible("InlineError",!String.IsNullOrEmpty(message)); }
    private static string ParentDirectoryForPicker(string installDirectory) {
      if(String.IsNullOrWhiteSpace(installDirectory))return Policy.DefaultDirectory();
      string full;try{full=Path.GetFullPath(installDirectory);}catch{return Policy.DefaultDirectory();}
      try { if(String.Equals(new DirectoryInfo(full).Name,AppFolderName,StringComparison.OrdinalIgnoreCase)) { var parent=Directory.GetParent(full); if(parent!=null)return parent.FullName; } } catch {}
      return full;
    }
    private static string AppDirectoryForParent(string parent) {
      string full=Path.GetFullPath(parent),name="";
      try { name=new DirectoryInfo(full).Name; } catch {}
      return Policy.AppDirectory(String.Equals(name,AppFolderName,StringComparison.OrdinalIgnoreCase)?full:Path.Combine(full,AppFolderName));
    }
    private string PickInstallParent(string initialDirectory) {
      string start=initialDirectory;
      if(String.IsNullOrWhiteSpace(start)||!Directory.Exists(start))start=Path.GetPathRoot(Environment.SystemDirectory);
      if(String.IsNullOrWhiteSpace(start)||!Directory.Exists(start))return null;
      var picker=new Window {Title="Папка установки Aplot",Width=760,Height=620,ResizeMode=ResizeMode.NoResize,WindowStyle=WindowStyle.None,
        WindowStartupLocation=WindowStartupLocation.CenterOwner,Owner=window,ShowInTaskbar=false,Background=new SolidColorBrush(Color.FromRgb(11,13,16)),
        Foreground=new SolidColorBrush(Color.FromRgb(237,241,244)),FontFamily=window.FontFamily,FontSize=14,
        BorderBrush=new SolidColorBrush(Color.FromRgb(40,48,56)),BorderThickness=new Thickness(1),Icon=window.Icon};
      picker.Resources=window.Resources;
      var frame=new Grid();frame.RowDefinitions.Add(new RowDefinition{Height=new GridLength(58)});frame.RowDefinitions.Add(new RowDefinition());frame.RowDefinitions.Add(new RowDefinition{Height=new GridLength(74)});
      var titleBar=new Border {Background=new SolidColorBrush(Color.FromRgb(14,17,20)),BorderBrush=new SolidColorBrush(Color.FromRgb(34,41,48)),BorderThickness=new Thickness(0,0,0,1)};
      var titleGrid=new Grid {Margin=new Thickness(20,0,10,0)};titleGrid.ColumnDefinitions.Add(new ColumnDefinition());titleGrid.ColumnDefinitions.Add(new ColumnDefinition{Width=GridLength.Auto});
      var titleContents=new StackPanel {Orientation=Orientation.Horizontal,VerticalAlignment=VerticalAlignment.Center};
      titleContents.Children.Add(new Image {Source=Find<Image>("BrandLogo").Source,Width=28,Height=28,Margin=new Thickness(0,0,10,0)});
      titleContents.Children.Add(new TextBlock {Text="Выберите папку установки",FontSize=16,FontWeight=FontWeights.SemiBold,VerticalAlignment=VerticalAlignment.Center});titleGrid.Children.Add(titleContents);
      var closePicker=new Button {Content="✕",Width=38,Height=36,Padding=new Thickness(0),Background=Brushes.Transparent,BorderBrush=Brushes.Transparent,VerticalAlignment=VerticalAlignment.Center};
      closePicker.Click+=delegate {picker.DialogResult=false;};Grid.SetColumn(closePicker,1);titleGrid.Children.Add(closePicker);titleBar.Child=titleGrid;
      titleBar.MouseLeftButtonDown+=delegate(object sender,MouseButtonEventArgs e){if(!(e.OriginalSource is Button)&&e.LeftButton==MouseButtonState.Pressed)picker.DragMove();};Grid.SetRow(titleBar,0);frame.Children.Add(titleBar);

      var body=new Grid {Margin=new Thickness(22,19,22,16)};
      body.RowDefinitions.Add(new RowDefinition{Height=GridLength.Auto});body.RowDefinitions.Add(new RowDefinition{Height=GridLength.Auto});body.RowDefinitions.Add(new RowDefinition{Height=new GridLength(1,GridUnitType.Star)});body.RowDefinitions.Add(new RowDefinition{Height=GridLength.Auto});
      var intro=new StackPanel();intro.Children.Add(new TextBlock {Text="Выберите родительскую папку",FontSize=19,FontWeight=FontWeights.SemiBold});
      intro.Children.Add(new TextBlock {Text="В ней будет создана папка приложения Aplot Control LLM.",Foreground=Muted,Margin=new Thickness(0,5,0,0)});Grid.SetRow(intro,0);body.Children.Add(intro);
      var navigation=new Grid {Margin=new Thickness(0,15,0,12)};navigation.ColumnDefinitions.Add(new ColumnDefinition{Width=GridLength.Auto});navigation.ColumnDefinitions.Add(new ColumnDefinition());navigation.ColumnDefinitions.Add(new ColumnDefinition{Width=GridLength.Auto});navigation.ColumnDefinitions.Add(new ColumnDefinition{Width=GridLength.Auto});
      var upButton=new Button {Content="↑",ToolTip="На уровень выше",Width=44,Height=40,Padding=new Thickness(0),Margin=new Thickness(0,0,8,0)};navigation.Children.Add(upButton);
      var pathBox=new TextBox {IsReadOnly=true,VerticalContentAlignment=VerticalAlignment.Center,Height=40};Grid.SetColumn(pathBox,1);navigation.Children.Add(pathBox);
      var driveButton=new Button {Content="Диски",Margin=new Thickness(8,0,0,0),Padding=new Thickness(13,8,13,8)};Grid.SetColumn(driveButton,2);navigation.Children.Add(driveButton);
      var refreshButton=new Button {Content="Обновить",Margin=new Thickness(8,0,0,0),Padding=new Thickness(13,8,13,8)};Grid.SetColumn(refreshButton,3);navigation.Children.Add(refreshButton);Grid.SetRow(navigation,1);body.Children.Add(navigation);
      Style folderItemStyle=(Style)window.FindResource("FolderTreeItem");
      var folderTree=new TreeView {BorderThickness=new Thickness(0),Padding=new Thickness(5),Background=new SolidColorBrush(Color.FromRgb(14,17,20)),Foreground=window.Foreground,FontSize=13,HorizontalContentAlignment=HorizontalAlignment.Stretch,ItemContainerStyle=folderItemStyle};
      var folderScroll=new ScrollViewer {Content=folderTree,VerticalScrollBarVisibility=ScrollBarVisibility.Auto,HorizontalScrollBarVisibility=ScrollBarVisibility.Disabled,Background=new SolidColorBrush(Color.FromRgb(14,17,20))};
      var listFrame=new Border {Background=new SolidColorBrush(Color.FromRgb(14,17,20)),BorderBrush=new SolidColorBrush(Color.FromRgb(54,64,74)),BorderThickness=new Thickness(1),CornerRadius=new CornerRadius(6),Child=folderScroll};Grid.SetRow(listFrame,2);body.Children.Add(listFrame);
      var folderPreview=new TextBlock {Foreground=new SolidColorBrush(Color.FromRgb(185,215,162)),Margin=new Thickness(0,12,0,0),TextWrapping=TextWrapping.Wrap};Grid.SetRow(folderPreview,3);body.Children.Add(folderPreview);Grid.SetRow(body,1);frame.Children.Add(body);

      var footer=new Border {Background=new SolidColorBrush(Color.FromRgb(14,17,20)),BorderBrush=new SolidColorBrush(Color.FromRgb(34,41,48)),BorderThickness=new Thickness(0,1,0,0)};
      var footerGrid=new Grid {Margin=new Thickness(22,13,22,13)};footerGrid.ColumnDefinitions.Add(new ColumnDefinition());footerGrid.ColumnDefinitions.Add(new ColumnDefinition{Width=GridLength.Auto});footerGrid.ColumnDefinitions.Add(new ColumnDefinition{Width=GridLength.Auto});
      footerGrid.Children.Add(new TextBlock {Text="В выбранной папке будет создана папка приложения.",Foreground=Muted,VerticalAlignment=VerticalAlignment.Center});
      var cancelButton=new Button {Content="Отмена",MinWidth=100,Margin=new Thickness(0,0,9,0)};cancelButton.Click+=delegate {picker.DialogResult=false;};Grid.SetColumn(cancelButton,1);footerGrid.Children.Add(cancelButton);
      var chooseButton=new Button {Content="Выбрать папку",MinWidth=150,Style=(Style)window.FindResource("Primary")};Grid.SetColumn(chooseButton,2);footerGrid.Children.Add(chooseButton);
      footer.Child=footerGrid;Grid.SetRow(footer,2);frame.Children.Add(footer);picker.Content=new Border {BorderBrush=new SolidColorBrush(Color.FromRgb(40,48,56)),BorderThickness=new Thickness(1),Child=frame};

      string selectedPath=null;TreeViewItem computerNode=null;Action refresh=null;Action updatePreview=null;Action<string> selectTreePath=null;Action<TreeViewItem,string> loadFolderChildren=null;Func<string,string,bool,TreeViewItem> makeFolderNode=null;
      updatePreview=delegate {
        bool exists=!String.IsNullOrWhiteSpace(selectedPath)&&Directory.Exists(selectedPath);chooseButton.IsEnabled=exists;
        folderPreview.Text=exists?"Папка приложения: "+AppDirectoryForParent(selectedPath):selectedPath==null?"Выберите диск, чтобы продолжить.":"Выберите доступную папку.";
      };
      Func<string,string,UIElement> makeHeader=delegate(string label,string kind) {
        var header=new DockPanel {LastChildFill=true,HorizontalAlignment=HorizontalAlignment.Stretch};
        string geometry=kind=="computer"?"M 2,2 L 18,2 L 18,13 L 2,13 Z M 8,14 L 12,14 L 12,16 L 8,16 Z M 5,17 L 15,17":kind=="drive"?"M 2,4 L 18,4 L 18,15 L 2,15 Z":"M 1,4 L 7,4 L 9,6 L 18,6 L 18,15 L 1,15 Z";
        Color fill=kind=="computer"?Color.FromRgb(98,201,236):kind=="drive"?Color.FromRgb(130,183,216):Color.FromRgb(226,177,83);
        var icon=new System.Windows.Shapes.Path {Data=Geometry.Parse(geometry),Fill=new SolidColorBrush(fill),Stroke=new SolidColorBrush(Color.FromRgb(27,35,42)),StrokeThickness=.6,Width=18,Height=16,Stretch=Stretch.Fill,Margin=new Thickness(0,0,6,0),VerticalAlignment=VerticalAlignment.Center};
        DockPanel.SetDock(icon,Dock.Left);header.Children.Add(icon);
        header.Children.Add(new TextBlock {Text=label,FontSize=13,Foreground=window.Foreground,TextTrimming=TextTrimming.CharacterEllipsis,VerticalAlignment=VerticalAlignment.Center});
        return header;
      };
      loadFolderChildren=delegate(TreeViewItem parent,string path) {
        try {
          foreach(string childPath in Directory.GetDirectories(path).OrderBy(item=>Path.GetFileName(item),StringComparer.CurrentCultureIgnoreCase))try {
            if((File.GetAttributes(childPath)&FileAttributes.ReparsePoint)==0)parent.Items.Add(makeFolderNode(childPath,Path.GetFileName(childPath),false));
          } catch {}
        } catch(UnauthorizedAccessException) {parent.Items.Add(new TreeViewItem {Header="Нет доступа к вложенным папкам",IsEnabled=false,Focusable=false});}
          catch(IOException) {parent.Items.Add(new TreeViewItem {Header="Не удалось прочитать папку",IsEnabled=false,Focusable=false});}
      };
      makeFolderNode=delegate(string path,string label,bool drive) {
        string fullPath=Path.GetFullPath(path);var marker=new object();bool loaded=false;
        var node=new TreeViewItem {Header=makeHeader(label,drive?"drive":"folder"),Tag=fullPath,ToolTip=fullPath,Foreground=window.Foreground,HorizontalContentAlignment=HorizontalAlignment.Stretch,ItemContainerStyle=folderItemStyle};
        node.Items.Add(marker);
        node.Expanded+=delegate {if(loaded)return;loaded=true;node.Items.Clear();loadFolderChildren(node,fullPath);};
        return node;
      };
      folderTree.SelectedItemChanged+=delegate {
        var selected=folderTree.SelectedItem as TreeViewItem;selectedPath=selected==null?null:Convert.ToString(selected.Tag);
        if(String.IsNullOrWhiteSpace(selectedPath))selectedPath=null;
        pathBox.Text=selectedPath??"Этот компьютер";upButton.IsEnabled=selectedPath!=null&&Directory.GetParent(selectedPath)!=null;updatePreview();
      };
      selectTreePath=delegate(string path) {
        if(computerNode==null)return;
        if(String.IsNullOrWhiteSpace(path)||!Directory.Exists(path)){computerNode.IsSelected=true;return;}
        string fullPath=Path.GetFullPath(path),rootPath=Path.GetPathRoot(Path.GetFullPath(path));
        TreeViewItem current=computerNode.Items.OfType<TreeViewItem>().FirstOrDefault(item=>String.Equals(Convert.ToString(item.Tag),rootPath,StringComparison.OrdinalIgnoreCase));
        if(current==null){computerNode.IsSelected=true;return;}
        current.IsExpanded=true;
        foreach(string segment in fullPath.Substring(rootPath.Length).Split(new [] {Path.DirectorySeparatorChar,Path.AltDirectorySeparatorChar},StringSplitOptions.RemoveEmptyEntries)) {
          var child=current.Items.OfType<TreeViewItem>().FirstOrDefault(item=>String.Equals(Path.GetFileName(Convert.ToString(item.Tag)),segment,StringComparison.OrdinalIgnoreCase));
          if(child==null)break;current=child;current.IsExpanded=true;
        }
        current.IsSelected=true;current.BringIntoView();
      };
      refresh=delegate {
        string pathToSelect=selectedPath??start;folderTree.Items.Clear();selectedPath=null;
        var marker=new object();bool drivesLoaded=false;
        computerNode=new TreeViewItem {Header=makeHeader("Этот компьютер","computer"),ToolTip="Этот компьютер",Foreground=window.Foreground,HorizontalContentAlignment=HorizontalAlignment.Stretch,ItemContainerStyle=folderItemStyle};
        computerNode.Items.Add(marker);
        computerNode.Expanded+=delegate {
          if(drivesLoaded)return;drivesLoaded=true;computerNode.Items.Clear();
          try {foreach(DriveInfo drive in DriveInfo.GetDrives().OrderBy(item=>item.Name,StringComparer.OrdinalIgnoreCase))try {
            if(drive.IsReady){string path=drive.RootDirectory.FullName;string label=String.IsNullOrWhiteSpace(drive.VolumeLabel)?path:drive.VolumeLabel+" ("+path.TrimEnd('\\')+")";computerNode.Items.Add(makeFolderNode(path,label,true));}
          } catch {}} catch {}
        };
        folderTree.Items.Add(computerNode);computerNode.IsExpanded=true;selectTreePath(pathToSelect);updatePreview();
      };
      upButton.Click+=delegate {if(String.IsNullOrWhiteSpace(selectedPath)){computerNode.IsSelected=true;return;}var parent=Directory.GetParent(selectedPath);if(parent==null)computerNode.IsSelected=true;else selectTreePath(parent.FullName);};
      driveButton.Click+=delegate {computerNode.IsSelected=true;computerNode.BringIntoView();};
      refreshButton.Click+=delegate {refresh();};
      chooseButton.Click+=delegate {if(!String.IsNullOrWhiteSpace(selectedPath)&&Directory.Exists(selectedPath)){picker.Tag=Path.GetFullPath(selectedPath);picker.DialogResult=true;}else updatePreview();};
      picker.KeyDown+=delegate(object sender,KeyEventArgs e){if(e.Key==Key.Escape){picker.DialogResult=false;e.Handled=true;}};
      refresh();picker.ShowDialog();return picker.DialogResult==true?Convert.ToString(picker.Tag):null;
    }
    private async Task Initialize() {
      busy = true; UpdateNext(); Text("FooterStatus","Ищем установленное приложение и компоненты…");
      string inspectionError="";
      try {
        found = await Task.Run(() => FindInstallation());
        directory = maintenance ? Get("app-directory",found == null ? "" : found.Directory)
          : Get("suggested-directory",found == null ? Policy.DefaultDirectory() : found.Directory);
        Find<TextBox>("InstallDirectory").Text = directory;
        await InspectDirectory();
      } catch(Exception e) { inspectionError="Не удалось проверить установку. " + e.Message; }
      finally { busy = false; initializing = false; RefreshChoices(); Show(0); if(inspectionError.Length>0)Error(inspectionError); }
    }
    private Installation FindInstallation() {
      if (preview && Get("scenario","") == "installed") return new Installation { Directory=Path.Combine(work,"Aplot Control LLM"), Version="0.7.9", Registered=true };
      string explicitDirectory=Get("app-directory","");
      if (maintenance && !String.IsNullOrEmpty(explicitDirectory)) return new Installation { Directory=Policy.AppDirectory(explicitDirectory), Version=version, Registered=File.Exists(Path.Combine(explicitDirectory,"uninstall.exe")) };
      // The supported NSIS product identity is stable across updates. Do not touch unrelated products.
      foreach (RegistryHive hive in new [] {RegistryHive.CurrentUser,RegistryHive.LocalMachine}) {
        foreach (RegistryView view in new [] {RegistryView.Registry64,RegistryView.Registry32}) {
          using(var registry=RegistryKey.OpenBaseKey(hive,view))
          using(var key=registry.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\Aplot Control LLM")) {
            if (key == null || Convert.ToString(key.GetValue("DisplayName")) != "Aplot Control LLM") continue;
            string location=Convert.ToString(key.GetValue("InstallLocation")).Trim('"');
            if (!String.IsNullOrWhiteSpace(location)) return new Installation { Directory=Policy.AppDirectory(location), Version=Convert.ToString(key.GetValue("DisplayVersion")), Registered=true, Machine=hive==RegistryHive.LocalMachine };
          }
        }
      }
      return null;
    }
    private async Task InspectDirectory() {
      directory = Policy.AppDirectory(Find<TextBox>("InstallDirectory").Text);
      if (found == null || !String.Equals(found.Directory,directory,StringComparison.OrdinalIgnoreCase)) {
        found = null; string binary=Path.Combine(directory,"aplot-control-llm.exe");
        if (File.Exists(binary)) {
          var info=FileVersionInfo.GetVersionInfo(binary);
          if ((info.ProductName ?? "").IndexOf("Aplot",StringComparison.OrdinalIgnoreCase) >= 0)
            found=new Installation {Directory=directory,Version=info.ProductVersion,Registered=File.Exists(Path.Combine(directory,"uninstall.exe"))};
        }
      }
      if (found != null) {
        Visible("ExistingBanner",true); Text("ExistingTitle", "Найден Aplot " + found.Version);
        Text("ExistingDescription", maintenance ? "Выберите удаление приложения или изменение состава компонентов. На следующем шаге можно отдельно выбрать движки и агентов." : found.Machine ? "Установка для всех пользователей. Этот мастер управляет пользовательской установкой; автоматическое обновление здесь недоступно."
          : found.Registered ? "Можно обновить приложение на месте или изменить состав компонентов. Данные сохраняются." : "Найдена отдельная копия приложения. Можно установить новую версию в эту же папку с регистрацией в Windows.");
        Text("ApplicationActionTitle",maintenance ? "Удалить приложение Aplot" : Policy.VersionOf(found.Version) == Policy.VersionOf(version) ? "Восстановить текущую версию" : "Обновить Aplot до " + version);
        Text("ApplicationActionDescription",maintenance ? "Приложение будет удалено. Дополнительные модули выбираются на следующем шаге." : "Обновятся файлы приложения. Настройки, проекты, профили и модели останутся.");
        if (!maintenance && !Policy.CanUpdate(found,version)) Error(found.Machine ? "Для этой установки нужен установщик с поддержкой установки для всех пользователей." : "Установлена более новая версия Aplot. Обновление более старой версией заблокировано; состав компонентов можно изменить.");
      } else {
        Visible("ExistingBanner",false); Text("ApplicationActionTitle","Установить Aplot " + version); Text("ApplicationActionDescription","Приложение и, по вашему выбору, движки и агенты.");
      }
      Visible("ModulesAction",found != null); Visible("InstallModePanel",!maintenance);
      Visible("ApplicationAction",maintenance || found!=null);
      System.Windows.Automation.AutomationProperties.SetName(Find<RadioButton>("ApplicationAction"),Find<TextBlock>("ApplicationActionTitle").Text);
      Find<TextBox>("InstallDirectory").IsReadOnly=found != null && found.Registered;
      Find<Button>("BrowseButton").IsEnabled=!(found != null && found.Registered);
      Text("PathHelp",maintenance ? "Папка установленного приложения. Удаление компонентов и данных выбирается отдельно." : found != null && found.Registered ? "Обновление выполнится в папке найденной установки. Настройки, проекты и модели сохраняются." : "Найденные движки и агенты можно перенести под управление Aplot. Веса моделей не скачиваются.");
      owned.Clear(); existing.Clear(); existingPaths.Clear();
      if (!File.Exists(probe)) throw new Exception("Не найден модуль проверки установки. Запустите полный setup.exe.");
      string statePath=Path.Combine(work,"state.json");
      int code=await Run(probe,new [] {"--component-maintenance-state",statePath,directory},false,30000);
      if (code != 0 || !File.Exists(statePath)) throw new Exception("Модуль проверки не вернул сведения об установке.");
      foreach(object raw in ArrayOf(ReadJson(statePath),"modules")) {
        var row=Obj(raw); string id=Str(row,"id");
        if (ArrayOf(row,"paths").Length > 0) owned[id]=row;
        if (!String.IsNullOrEmpty(Str(row,"externalPath")) || owned.ContainsKey(id)) existing.Add(id);
        string externalPath=Str(row,"externalPath");
        if(!String.IsNullOrEmpty(externalPath))existingPaths[id]=externalPath;
        else if(ArrayOf(row,"paths").Length>0)existingPaths[id]=Convert.ToString(ArrayOf(row,"paths")[0]);
      }
      Visible("ModulesAction",found!=null||owned.Count>0);
      string report=Path.Combine(work,"existing.json");
      if (await Run(probe,new [] {"--component-inventory",report,directory,DiscoveryOrigin()},false,30000) == 0 && File.Exists(report))
        foreach(object raw in ArrayOf(ReadJson(report),"components")) {
          var row=Obj(raw);string id=Str(row,"id");existing.Add(id);
          if(!existingPaths.ContainsKey(id))existingPaths[id]=Str(row,"path");
        }
      RefreshChoices();
    }
    private bool IsModulesOnly() { return Checked("ModulesAction"); }
    private bool IsRemoving() { return maintenance && !IsModulesOnly() || IsModulesOnly() && Checked("RemoveModules"); }
    private bool NeedsChoices() { return maintenance || IsModulesOnly() || Checked("CustomComponents"); }
    private string DiscoveryOrigin() { return Path.GetDirectoryName(Get("core-installer",Path.Combine(directory,"setup.exe"))); }
    private string AppComponentRoot() { return Path.Combine(directory,"components"); }
    private bool IsInside(string path,string root) {
      if(String.IsNullOrWhiteSpace(path)||String.IsNullOrWhiteSpace(root))return false;
      try {
        string full=Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar,Path.AltDirectorySeparatorChar)+Path.DirectorySeparatorChar;
        string parent=Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar,Path.AltDirectorySeparatorChar)+Path.DirectorySeparatorChar;
        return full.StartsWith(parent,StringComparison.OrdinalIgnoreCase);
      } catch {return false;}
    }
    private bool NeedsMigration(string id) {
      string path;return existing.Contains(id)&&(!existingPaths.TryGetValue(id,out path)||!IsInside(path,AppComponentRoot()));
    }
    private bool UsesAppComponentRoot() {
      return Checked("MigrateExisting")||File.Exists(Path.Combine(AppComponentRoot(),"installations.json"));
    }
    private string ComponentInstallRoot() {
      return UsesAppComponentRoot()?AppComponentRoot():Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),@"Aplot Control LLM\components");
    }
    private List<Dictionary<string,object>> SelectedLicenses() {
      var ids=new HashSet<string>();
      if(!IsRemoving()) {
        if(!IsModulesOnly())ids.Add("apache");
        foreach(var row in CatalogRows().Where(row=>Selection().Contains(Str(row,"id")))) {
          string id=Str(row,"id");
          if(existing.Contains(id)&&Checked("ReuseExisting")&&!(Checked("MigrateExisting")&&NeedsMigration(id)))continue;
          foreach(object license in ArrayOf(row,"licenses"))ids.Add(Convert.ToString(license));
          if(!withoutDependencies.Contains(id)) {
            if(ArrayOf(row,"dependencyIds").Contains("git"))ids.Add("git");
            if(ArrayOf(row,"dependencyIds").Contains("msvc"))ids.Add("msvc");
            if(ArrayOf(row,"dependencyIds").Contains("python")){ids.Add("python");ids.Add("uv");ids.Add(id+"-python-notices");}
            if(id=="strata")ids.Add("cuda");
          }
        }
      }
      return ArrayOf(licenses,"licenses").Select(Obj).Where(row=>ids.Contains(Str(row,"id"))).ToList();
    }
    private bool RequiresLicense() { return SelectedLicenses().Count>0; }
    private void OpenLicenses() {
      var rows=SelectedLicenses();if(rows.Count==0)return;
      var reader=new Window {Title="Лицензионные соглашения",Owner=window,Width=940,Height=680,ResizeMode=ResizeMode.NoResize,WindowStyle=WindowStyle.None,BorderBrush=new SolidColorBrush(Color.FromRgb(40,48,56)),BorderThickness=new Thickness(1),WindowStartupLocation=WindowStartupLocation.CenterOwner,Background=window.Background,Foreground=window.Foreground,FontFamily=window.FontFamily,FontSize=15,Icon=window.Icon};
      reader.Resources=window.Resources;
      var grid=new Grid {Margin=new Thickness(22)};grid.RowDefinitions.Add(new RowDefinition{Height=GridLength.Auto});grid.RowDefinitions.Add(new RowDefinition());grid.RowDefinitions.Add(new RowDefinition{Height=GridLength.Auto});
      grid.Children.Add(new TextBlock {Text="Лицензионные соглашения",FontSize=25,FontWeight=FontWeights.SemiBold,Margin=new Thickness(0,0,0,18)});
      var body=new Grid();body.ColumnDefinitions.Add(new ColumnDefinition{Width=new GridLength(235)});body.ColumnDefinitions.Add(new ColumnDefinition());Grid.SetRow(body,1);grid.Children.Add(body);
      var list=new ListBox {Background=new SolidColorBrush(Color.FromRgb(19,23,27)),Foreground=window.Foreground,BorderThickness=new Thickness(0),Margin=new Thickness(0,0,18,0),HorizontalContentAlignment=HorizontalAlignment.Stretch};body.Children.Add(list);
      ScrollViewer.SetHorizontalScrollBarVisibility(list,ScrollBarVisibility.Disabled);
      var document=new FlowDocumentScrollViewer {IsToolBarVisible=false,VerticalScrollBarVisibility=ScrollBarVisibility.Auto};Grid.SetColumn(document,1);body.Children.Add(document);
      foreach(var row in rows)list.Items.Add(new ListBoxItem {Content=new TextBlock{Text=Str(row,"title"),TextWrapping=TextWrapping.Wrap,Margin=new Thickness(10),FontSize=15},Foreground=window.Foreground,Background=Brushes.Transparent});
      var footer=new Grid {Margin=new Thickness(0,18,0,0)};footer.ColumnDefinitions.Add(new ColumnDefinition());footer.ColumnDefinitions.Add(new ColumnDefinition{Width=GridLength.Auto});Grid.SetRow(footer,2);grid.Children.Add(footer);
      var source=new Button {Content="Официальный источник",HorizontalAlignment=HorizontalAlignment.Left};footer.Children.Add(source);
      var close=new Button {Content="Закрыть",MinWidth=120};close.Click+=delegate{reader.Close();};Grid.SetColumn(close,1);footer.Children.Add(close);
      reader.PreviewKeyDown+=delegate(object sender,KeyEventArgs e){if(e.Key==Key.Escape)reader.Close();};
      source.Click+=delegate {if(list.SelectedIndex>=0)Process.Start(new ProcessStartInfo(Str(rows[list.SelectedIndex],"source")){UseShellExecute=true});};
      list.SelectionChanged+=delegate {
        if(list.SelectedIndex<0)return;
        var row=rows[list.SelectedIndex];var flow=new FlowDocument {FontFamily=window.FontFamily,FontSize=16,LineHeight=26,Foreground=window.Foreground,Background=window.Background,PagePadding=new Thickness(10,0,15,15)};
        flow.Blocks.Add(new Paragraph(new Run(Str(row,"title"))){FontSize=21,FontWeight=FontWeights.SemiBold,Margin=new Thickness(0,0,0,20)});
        foreach(string paragraph in System.Text.RegularExpressions.Regex.Split(Str(row,"text").Replace("\r","").Trim(),"\n[ \\t]*\n")) {
          string text=System.Text.RegularExpressions.Regex.Replace(paragraph.Trim(),"[ \\t]*\n[ \\t]*"," ");
          flow.Blocks.Add(new Paragraph(new Run(text)){Margin=new Thickness(0,0,0,16)});
        }
        document.Document=flow;
      };
      reader.Content=grid;list.SelectedIndex=0;reader.ShowDialog();
    }
    private HashSet<string> Selection() { return IsRemoving() ? removeSelection : addSelection; }
    private IEnumerable<Dictionary<string,object>> CatalogRows() { return ArrayOf(catalog,"components").Select(Obj).Where(r=>r!=null); }
    private string Name(string id) { var row=CatalogRows().FirstOrDefault(r=>Str(r,"id")==id); return row==null ? id=="cache" ? "Архивы и кэш загрузок" : "Общие Python и uv" : Str(row,"name"); }
    private double Bytes(Dictionary<string,object> row) { double value; return Double.TryParse(Str(row,"bytes"),NumberStyles.Any,CultureInfo.InvariantCulture,out value) ? value : 0; }
    private static double ArtifactSize(object artifact) {
      double value;
      var data=Obj(artifact);
      return data!=null&&Double.TryParse(Str(data,"size"),NumberStyles.Any,CultureInfo.InvariantCulture,out value)&&!Double.IsNaN(value)&&!Double.IsInfinity(value)&&value>0?value:0;
    }
    private double Download(Dictionary<string,object> row) {
      string id=Str(row,"id");
      if (Checked("ReuseExisting") && existing.Contains(id) && !(Checked("MigrateExisting")&&NeedsMigration(id))) return 0;
      object artifactData;
      if(!row.TryGetValue("artifacts",out artifactData))return 0;
      var artifacts=Obj(artifactData); if(artifacts==null)return 0;
      string method=Str(row,"method");
      string artifactKey=method=="archive"||method=="binary"?"binary":"source";
      object sourceData;
      if(!artifacts.TryGetValue(artifactKey,out sourceData))return 0;
      double size=ArtifactSize(sourceData);
      if(method=="strata") {
        double engineSize=artifacts.Where(item=>item.Key.StartsWith("cuda",StringComparison.OrdinalIgnoreCase)||item.Key.StartsWith("hip-",StringComparison.OrdinalIgnoreCase))
          .Select(item=>ArtifactSize(item.Value)).Where(value=>value>0).DefaultIfEmpty(0).Min();
        size+=engineSize;
      }
      return size;
    }
    private static string Size(double bytes) { return bytes>=1024*1024*1024 ? (bytes/1024/1024/1024).ToString("0.0",CultureInfo.GetCultureInfo("ru-RU"))+" ГБ" : Math.Max(0.1,bytes/1024/1024).ToString("0.#",CultureInfo.GetCultureInfo("ru-RU"))+" МБ"; }
    private void RefreshChoices() {
      if (initializing) return;
      if(page==1) {
        Text("PageTitle",IsRemoving()?"Что нужно удалить?":"Выберите нужные компоненты");
        Text("PageDescription",IsRemoving()?"Ничего не выбрано автоматически. Отметьте только ненужное.":"Галочки независимы. Уже установленные компоненты можно использовать повторно.");
      }
      if(!IsRemoving()&&!IsModulesOnly()&&!Checked("CustomComponents"))addSelection.Clear();
      Visible("InstallModePanel",!maintenance && !IsModulesOnly());
      Visible("ComponentOperationPanel",IsModulesOnly());
      Visible("ReuseExisting",!IsRemoving());
      bool migrationAvailable=!IsRemoving()&&existing.Any(NeedsMigration);
      Visible("MigrateExisting",migrationAvailable);Visible("MigrateExistingHint",migrationAvailable);
      if(migrationAvailable)Text("MigrateExistingHint","Aplot установит и проверит управляемую копию в папке приложения. Исходная установка останется на месте до проверки. Папка компонентов: "+AppComponentRoot());
      else if(Checked("MigrateExisting"))Find<CheckBox>("MigrateExisting").IsChecked=false;
      Find<StackPanel>("EngineCards").Children.Clear(); Find<StackPanel>("AgentCards").Children.Clear(); Find<StackPanel>("SharedCards").Children.Clear();
      foreach(var row in CatalogRows()) {
        string id=Str(row,"id");
        if (IsRemoving() && !owned.ContainsKey(id)) continue;
        string description=Str(Obj(row["description"]),"ru"); string release=Str(row,"version"); string status;
        string right;
        bool enabled=true;
        if (IsRemoving()) {
          var data=owned[id]; release=String.Join(", ",ArrayOf(data,"versions").Select(Convert.ToString)); status="Установлено Aplot"; right=Size(Bytes(data));
          description="Будут удалены принадлежащие Aplot файлы этого компонента.";
          enabled=String.IsNullOrEmpty(Str(data,"blocked"));
          if (!enabled) { status="Нужно проверить ссылки или доступ к файлам"; removeSelection.Remove(id); }
        } else {
          bool migrating=Selection().Contains(id)&&Checked("MigrateExisting")&&NeedsMigration(id);
          status=existing.Contains(id) ? migrating ? "Будет перенесён под управление Aplot" : Checked("ReuseExisting") ? "Уже установлен · используем готовую установку" : "Будет установлена отдельная версия" : "Будет скачан и установлен";
          double size=Download(row); right=existing.Contains(id) && Checked("ReuseExisting")&&!migrating ? "Готово" : size>0 ? "от "+Size(size) : "Размер уточнится";
        }
        AddCard(Str(row,"kind")=="agent" ? "AgentCards":"EngineCards",id,Str(row,"name"),release,description,status,right,enabled);
      }
      if (IsRemoving()) foreach(string id in new [] {"cache","python_runtime"}) {
        if (!owned.ContainsKey(id)) continue;
        bool allowed=id!="python_runtime" || Policy.PythonAllowed(owned.Keys,removeSelection);
        if (!allowed) removeSelection.Remove(id);
        AddCard("SharedCards",id,Name(id),"",id=="cache" ? "Скачанные архивы и кэш пакетов. Движки останутся работоспособны." : "Общее окружение для Strata и Hermes.",allowed ? "Можно удалить отдельно" : "Сначала отметьте установленные Strata и Hermes",Size(Bytes(owned[id])),allowed && String.IsNullOrEmpty(Str(owned[id],"blocked")));
      }
      Visible("SharedHeading",Find<StackPanel>("SharedCards").Children.Count>0);
      Visible("EnginesHeading",Find<StackPanel>("EngineCards").Children.Count>0);
      Visible("AgentsHeading",Find<StackPanel>("AgentCards").Children.Count>0);
      Text("ChoicesHint",IsRemoving() ? "Удаляются только модули, установленные Aplot. Внешние установки не затрагиваются. При удалении модуля удалятся все файлы внутри его папок."
        : "Источники — официальные репозитории. Python и зависимости будут установлены при выборе Strata / Hermes. Веса моделей не включены.");
      if (IsRemoving() && !owned.Any()) Text("ChoicesHint","Модулей, установленных через Aplot, не найдено. Внешние установки не удаляются. " + (IsModulesOnly() ? "Можно переключиться на добавление компонентов." : "Можно продолжить удаление только приложения."));
      UpdateFooter(); UpdateNext();
    }
    private void AddCard(string panel,string id,string name,string release,string description,string status,string right,bool enabled) {
      var border=new Border {Background=new SolidColorBrush(Color.FromRgb(19,23,27)),BorderBrush=new SolidColorBrush(Color.FromRgb(40,48,56)),BorderThickness=new Thickness(1),CornerRadius=new CornerRadius(7),Padding=new Thickness(16,13,16,13),Margin=new Thickness(0,0,0,9)};
      var check=new CheckBox {IsEnabled=enabled,IsChecked=Selection().Contains(id),HorizontalContentAlignment=HorizontalAlignment.Stretch};
      System.Windows.Automation.AutomationProperties.SetName(check,name+" · "+status);
      var grid=new Grid(); grid.ColumnDefinitions.Add(new ColumnDefinition()); grid.ColumnDefinitions.Add(new ColumnDefinition {Width=GridLength.Auto});
      var texts=new StackPanel(); texts.Children.Add(new TextBlock {Text=name,FontSize=17,FontWeight=FontWeights.SemiBold});
      texts.Children.Add(new TextBlock {Text=description,Foreground=Muted,FontSize=14,Margin=new Thickness(0,5,12,0),LineHeight=22});
      texts.Children.Add(new TextBlock {Text=status,Foreground=existing.Contains(id)&&!IsRemoving()?Lime:Muted,FontSize=14,Margin=new Thickness(0,7,0,0)});
      grid.Children.Add(texts); var size=new TextBlock {Text=right,Foreground=Muted,FontSize=14,Margin=new Thickness(10,2,0,0),TextAlignment=TextAlignment.Right}; Grid.SetColumn(size,1); grid.Children.Add(size); check.Content=grid;
      if(IsRemoving()&&owned.ContainsKey(id))check.ToolTip=String.Join(Environment.NewLine,ArrayOf(owned[id],"paths").Select(Convert.ToString));
      check.Click += delegate { if(check.IsChecked==true) {Selection().Add(id);withoutDependencies.Remove(id);} else Selection().Remove(id);Find<CheckBox>("AcceptLicense").IsChecked=false;RefreshChoices(); };
      var contents=new StackPanel();contents.Children.Add(check);
      var component=CatalogRows().FirstOrDefault(row=>Str(row,"id")==id);
      if(!IsRemoving()&&Selection().Contains(id)&&component!=null&&!(existing.Contains(id)&&Checked("ReuseExisting")&&!(Checked("MigrateExisting")&&NeedsMigration(id)))) {
        var packages=new CheckBox {Content="Установить дополнительные пакеты",IsChecked=!withoutDependencies.Contains(id),Margin=new Thickness(25,14,0,2),ToolTip=Str(component,"dependencyLabel")};
        System.Windows.Automation.AutomationProperties.SetName(packages,"Дополнительные пакеты для "+name);
        packages.Click+=delegate {if(packages.IsChecked==true)withoutDependencies.Remove(id);else withoutDependencies.Add(id);Find<CheckBox>("AcceptLicense").IsChecked=false;UpdateFooter();};
        contents.Children.Add(packages);
        contents.Children.Add(new TextBlock {Text=Str(component,"dependencyLabel"),Foreground=Muted,Margin=new Thickness(50,4,0,0),FontSize=14});
      }
      border.Child=contents; Find<StackPanel>(panel).Children.Add(border);
    }
    private void UpdateFooter() {
      int count=Selection().Count;
      Text("FooterStatus", count==0 ? IsModulesOnly()?"Выберите компоненты для работы":IsRemoving() ? "Модули сохранятся" : "Только приложение — без дополнительных загрузок" : "Выбрано компонентов: "+count);
      double total=IsRemoving()?Selection().Where(owned.ContainsKey).Sum(id=>Bytes(owned[id])):CatalogRows().Where(row=>Selection().Contains(Str(row,"id"))).Sum(row=>Download(row));
      Text("FooterDetail",total>0 ? (IsRemoving()?"Объём файлов: ":"Известный объём архивов: ")+Size(total)+(IsRemoving()?"":" + зависимости") : "Windows x64 · модели не скачиваются");
    }
    private void Show(int next) {
      page=next; Error("");
      string[] panels={"WelcomeStep","ChoicesStep","ReviewStep","ProgressStep","FinishStep"};
      for(int i=0;i<panels.Length;i++) { Visible(panels[i],i==page); Find<TextBlock>("Step"+i).Foreground=i==page?Lime:Muted; Find<TextBlock>("Step"+i).FontWeight=i==page?FontWeights.SemiBold:FontWeights.Normal; }
      string[] titles={maintenance?"Управление Aplot":"Подготовим вашу рабочую среду",IsRemoving()?"Что нужно удалить?":"Выберите нужные компоненты","Проверим перед началом",IsRemoving()?"Удаление выбранных компонентов":"Устанавливаем вашу среду","Готово"};
      string[] descriptions={maintenance?"Приложение и модули можно удалить отдельно.":"Приложение, локальные модели и агенты — без лишних установок.",IsRemoving()?"Ничего не выбрано автоматически. Отметьте только ненужное.":"Галочки независимы. Уже установленные компоненты можно использовать повторно.","Проверьте папку, выбранные компоненты и действие с приложением.","Здесь показан текущий этап. Подробности сохраняются в журнале.","Результат выполнения выбранных действий."};
      Text("PageTitle",titles[page]); Text("PageDescription",descriptions[page]);
      Find<ScrollViewer>("PageScroll").ScrollToTop();
      Visible("BackButton",page==1||page==2||page==4&&failures.Count>0);
      if(page==4) Find<Button>("BackButton").Content="К компонентам";
      else Find<Button>("BackButton").Content="Назад";
      if(page==2) Review();
      UpdateNext();
    }
    private void UpdateNext() {
      var next=Find<Button>("NextButton");
      next.IsEnabled=!busy && (page!=2 || !RequiresLicense() || Checked("AcceptLicense"));
      next.Content=page==4 ? shellSucceeded&&!IsRemoving()?"Открыть Aplot":"Закрыть" : page==2 ? maintenance&&!IsModulesOnly()?"Удалить Aplot":IsRemoving()?"Удалить модули":IsModulesOnly()?"Установить компоненты":found==null?"Установить Aplot":Policy.VersionOf(found.Version)==Policy.VersionOf(version)?"Восстановить Aplot":"Обновить Aplot" : "Продолжить →";
      next.Style=(Style)window.FindResource(page==2&&IsRemoving()?"Danger":"Primary");
      if(page==3) {next.IsEnabled=!cancelRequested;next.Content=cancelRequested?"Останавливаемся…":"Остановить после текущего";}
    }
    private async Task Next() {
      if(busy) { cancelRequested=true;Text("OperationDetail","Остановимся после текущего компонента.");UpdateNext();return; }
      try {
        if(page==0) {
          busy=true;UpdateNext();await InspectDirectory();busy=false;
          if(!IsModulesOnly()&&!maintenance&&!Policy.CanUpdate(found,version)) throw new Exception("Эту установку нельзя обновить выбранным выпуском. Используйте актуальный установщик или управление компонентами.");
          Show(NeedsChoices()?1:2);
        } else if(page==1) {
          if(IsModulesOnly()&&Selection().Count==0) throw new Exception("Выберите хотя бы один компонент.");
          Show(2);
        } else if(page==2) { await Execute(); }
        else if(page==4) {
          if(shellSucceeded&&!IsRemoving()) Process.Start(new ProcessStartInfo(Path.Combine(directory,"aplot-control-llm.exe")) {UseShellExecute=true});
          window.Close();
        }
      } catch(Exception e) { busy=false;Error(e.Message);UpdateNext(); }
    }
    private void Review() {
      bool app= !IsModulesOnly();
      Text("ReviewAction",app ? maintenance?"Удалить приложение Aplot":found==null?"Установить Aplot "+version:"Обновить / восстановить Aplot "+version : IsRemoving()?"Удалить выбранные компоненты":"Добавить выбранные компоненты");
      Text("ReviewPath",directory);
      Text("ReviewModules",Selection().Count==0 ? "Только приложение Aplot." : String.Join("\n",Selection().Select(id=>"• "+Name(id)+(IsRemoving()?" — удалить":Checked("MigrateExisting")&&NeedsMigration(id)?" — управляемая копия в "+AppComponentRoot():existing.Contains(id)&&Checked("ReuseExisting")?" — использовать установленный":withoutDependencies.Contains(id)?" — без дополнительных пакетов":" — с дополнительными пакетами"))));
      Text("ReviewDownload",Find<TextBlock>("FooterDetail").Text);
      Visible("DeleteUserData",maintenance&&app); Visible("LicensePanel",RequiresLicense()); Visible("AcceptLicense",RequiresLicense());
      Visible("ShortcutOptions",!maintenance&&app);
      Text("LicenseSummary","Лицензионные документы: "+SelectedLicenses().Count);
      Visible("RemovalFolders",IsRemoving()&&Selection().Count>0);
      Text("ReviewModulePaths",String.Join(Environment.NewLine,Selection().Where(owned.ContainsKey).SelectMany(id=>ArrayOf(owned[id],"paths").Select(Convert.ToString))));
      Text("ReviewPreserved",maintenance&&app&&Checked("DeleteUserData")?"Данные Aplot из профиля Windows будут удалены. Проекты, данные переносной копии и модели вне папок выбранных модулей сохраняются.":IsRemoving()?"Удаляются файлы внутри папок выбранных модулей. Внешние установки, модели вне этих папок и проекты сохраняются.":"Ваши настройки, проекты, история и модели сохраняются. "+(Checked("MigrateExisting")&&Selection().Any(NeedsMigration)?"Aplot создаст проверенные копии выбранных компонентов; исходные установки останутся на месте. ":"")+"Автоматического запуска серверов не будет.");
    }
    private bool AppRunning() {
      return Process.GetProcessesByName("aplot-control-llm").Any(process=>{
        try { return String.Equals(Path.GetDirectoryName(process.MainModule.FileName),directory,StringComparison.OrdinalIgnoreCase); }
        catch {return true;} finally {process.Dispose();}
      });
    }
    private void AddOutcome(string message,bool failed) {
      outcomes.Add(message); if(failed) failures.Add(message);
      processedUnits=Math.Min(totalUnits,processedUnits+1);UpdateOverallProgress();
      var text=new TextBlock {Text=(failed?"!   ":"✓   ")+message,Foreground=failed?new SolidColorBrush(Color.FromRgb(255,146,146)):Muted,Margin=new Thickness(0,0,0,10),LineHeight=21};
      Find<StackPanel>("OperationResults").Children.Add(text);
    }
    private void UpdateOverallProgress() {
      double percent=totalUnits==0?0:100.0*processedUnits/totalUnits;
      Find<ProgressBar>("OverallProgress").Value=percent;
      Text("OverallProgressText","Обработано компонентов: "+processedUnits+" из "+totalUnits+" · "+Math.Floor(percent)+"%");
    }
    private void SetStage(string title,string detail) {
      ApplyProgress(new ProgressInfo {title=title,detail=detail});
    }
    private static string ProgressSize(double value) {
      return value<1024*1024?(Math.Max(0,value)/1024).ToString("0.0")+" КБ":value>=1024*1024*1024?(value/1024/1024/1024).ToString("0.0")+" ГБ":(Math.Max(0,value)/1024/1024).ToString("0.0")+" МБ";
    }
    private void ApplyProgress(ProgressInfo value) {
      string identity=(value.stage??"")+value.title;
      if(identity!=currentStage){currentStage=identity;stageClock.Restart();}
      Text("OperationDetail",value.title);
      Visible("OperationProgress",value.percent.HasValue);
      if(value.percent.HasValue)Find<ProgressBar>("OperationProgress").Value=value.percent.Value;
      string detail=value.detail??"";
      if(value.downloaded.HasValue) {
        detail=ProgressSize(value.downloaded.Value)+(value.total>0?" из "+ProgressSize(value.total.Value):"");
        if(value.rate>0)detail+=" · "+ProgressSize(value.rate.Value)+"/с";
      }
      if(value.percent.HasValue)detail=(Math.Floor(value.percent.Value)+"%")+(detail.Length>0?" · "+detail:"");
      Text("OperationProgressText",detail);
    }
    private async Task Execute() {
      if(preview) throw new Exception("Предпросмотр интерфейса: установка и удаление здесь отключены.");
      if(!IsModulesOnly()&&AppRunning()) throw new Exception("Aplot сейчас работает. Сохраните задачи и выберите «Выход» в приложении, в том числе в трее. После закрытия повторите действие.");
      busy=true;cancelRequested=false;outcomes.Clear();failures.Clear();Find<StackPanel>("OperationResults").Children.Clear();Show(3);
      totalUnits=Selection().Count+(IsModulesOnly()?0:1);processedUnits=0;UpdateOverallProgress();operationClock.Restart();stageClock.Restart();progressTimer.Start();
      try {
        if(!maintenance&&!IsModulesOnly()) {
          Text("OperationTitle",found==null?"Устанавливаем приложение":"Обновляем файлы приложения");
          SetStage("Установка приложения и проверка WebView2","Ожидаем завершения системного установщика");
          string core=Get("core-installer",""); if(!File.Exists(core)) throw new Exception("Не найден основной установщик. Запустите полный setup.exe.");
          // Silent core preserves data and modules. Do not use /UPDATE: repair must also restore WebView2 and shortcuts.
          int code=await Run(core,Policy.InstallArguments(directory,Checked("DesktopShortcut"),Checked("StartMenuShortcut")),false);
          string target=Path.Combine(directory,"aplot-control-llm.exe");
          if(code!=0 || !File.Exists(Path.Combine(directory,"uninstall.exe")) || !File.Exists(target) || Hash(target)!=Hash(probe)) throw new Exception("Не удалось проверить файлы приложения после установки (код "+code+"). Данные и журнал доступны в папке установки.");
          shellSucceeded=true;AddOutcome("Приложение Aplot "+version+" готово",false);
        }
        if(IsRemoving()&&Selection().Count>0&&!cancelRequested) {
          Text("OperationTitle","Удаляем выбранные модули"); SetStage("Проверка процессов и удаление файлов","");
          string report=Path.Combine(work,"removal.json");
          int code=await Run(probe,new [] {"--remove-components",String.Join(",",Selection()),report,directory},false);
          if(File.Exists(report)) {
            var result=ReadJson(report);
            foreach(object id in ArrayOf(result,"removed")) AddOutcome(Name(Convert.ToString(id))+" — удалён",false);
            foreach(object error in ArrayOf(result,"errors")) AddOutcome(FriendlyError(Convert.ToString(error)),true);
          }
          if(code!=0&&failures.Count==0) AddOutcome("Не удалось удалить часть компонентов. Проверьте журнал.",true);
        } else if(!IsRemoving()) {
          string script=Path.Combine(assets,"Install-Components.ps1");
          foreach(string id in Selection().ToArray()) {
            if(cancelRequested) break;
            Text("OperationTitle",Name(id)+" · установка"); SetStage("Проверяем установленный компонент","");
            var command=new List<string>{"-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",script,"-Components",id,"-AppDirectory",directory,"-AppPath",probe};
            string root=ComponentInstallRoot();command.Add("-InstallRoot");command.Add(root);command.Add("-CacheRoot");command.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),@"Aplot Control LLM\components"));
            bool migrate=Checked("MigrateExisting")&&NeedsMigration(id);
            if(!Checked("ReuseExisting")||migrate) command.Add("-Fresh");
            if(withoutDependencies.Contains(id))command.Add("-SkipDependencies");
            command.Add("-DiscoveryRoot");command.Add(DiscoveryOrigin());
            DateTime started=DateTime.UtcNow;
            int code=await Run(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),@"WindowsPowerShell\v1.0\powershell.exe"),command,true);
            AddOutcome(Name(id)+(code==0?" — готов":" — не установлен. "+ComponentFailure(id,started)),code!=0);
          }
        }
        if(maintenance&&!IsModulesOnly()&&failures.Count==0&&!cancelRequested) {
          Text("OperationTitle","Удаляем приложение Aplot");SetStage("Удаление файлов приложения","");
          string core=Get("core-uninstaller",Path.Combine(directory,"uninstall.exe"));
          var command=new List<string>{"/S"};if(Checked("DeleteUserData"))command.Add("/DELETE_APP_DATA=1");
          int code=await Run(core,command,false);
          // NSIS relaunches its uninstaller from TEMP. Wait for the detached operation's completion marker.
          if(code!=0) throw new Exception("Деинсталлятор завершился с кодом "+code+". Проверьте, что Aplot закрыт.");
          for(int i=0;i<120&&File.Exists(Path.Combine(directory,"aplot-control-llm.exe"));i++)await Task.Delay(250);
          if(File.Exists(Path.Combine(directory,"aplot-control-llm.exe"))) throw new Exception("Файлы приложения остались на месте. Закройте Aplot и повторите удаление.");
          AddOutcome("Приложение Aplot удалено",false);
        }
      } catch(Exception e) { AddOutcome(e.Message,true); }
      finally {
        progressTimer.Stop();operationClock.Stop();stageClock.Stop();
        busy=false; ExitCode=failures.Count>0?1:0; Show(4);
        Text("FinishTitle",failures.Count>0?"Нужно внимание":cancelRequested?"Выполнение остановлено":"Всё готово");
        Text("FinishIcon",failures.Count>0?"!":"✓");
        Text("FinishDescription",failures.Count>0?"Часть действий не выполнена. Готовые компоненты сохранены. Можно вернуться к выбору и повторить неудавшееся. Журнал: "+technicalLog
          : cancelRequested?"Текущая операция завершена. Следующие компоненты не устанавливались.":maintenance&&!IsModulesOnly()?Checked("DeleteUserData")?"Aplot и его данные из профиля Windows удалены. Невыбранные модули, проекты и данные переносной копии сохранены.":"Aplot удалён. Невыбранные модули и пользовательские данные сохранены.":Checked("MigrateExisting")&&Selection().Any(NeedsMigration)?"Управляемые копии готовы в папке компонентов Aplot. Исходные установки остались на месте; новые пути будут использоваться при следующем запуске.":"Можно начать работу. Новые пути движков будут подставлены в пустые настройки приложения.");
        Find<StackPanel>("FinishResults").Children.Clear();
        foreach(string outcome in outcomes)Find<StackPanel>("FinishResults").Children.Add(new TextBlock {Text="• "+outcome,Foreground=Muted,Margin=new Thickness(0,0,0,9),LineHeight=21,TextWrapping=TextWrapping.Wrap});
        Text("FooterStatus",failures.Count>0?"Есть незавершённые действия":"Операция завершена");Text("FooterDetail","Журнал: "+technicalLog);
        UpdateNext();
      }
    }
    private string ComponentFailure(string id,DateTime started) {
      string report=Path.Combine(ComponentInstallRoot(),"last-result.json");
      try {
        if(File.Exists(report)&&File.GetLastWriteTimeUtc(report)>=started.AddSeconds(-2)) {
          foreach(object row in ArrayOf(ReadJson(report),"components")) {
            var entry=row as Dictionary<string,object>;
            if(entry!=null&&Convert.ToString(entry["id"])==id&&Convert.ToString(entry["status"])=="failed"&&entry.ContainsKey("error")) {
              string reason=Convert.ToString(entry["error"]);
              return reason.Length>1000?reason.Substring(0,1000)+"…":reason;
            }
          }
        }
      }catch{}
      return "Подробности в журнале. Вернитесь к компонентам и повторите установку.";
    }
    private string FriendlyError(string error) {
      if(error.Contains("process-active"))return "Компонент используется. Остановите его серверы и сессии агентов, затем повторите.";
      if(error.Contains("python-in-use"))return "Python нужен установленным Strata / Hermes. Сначала отметьте эти модули.";
      if(error.Contains("maintenance-busy"))return "Компоненты заняты другим установщиком. Дождитесь его завершения.";
      if(error.Contains("link-protected"))return "Найдена ссылка на другую папку. Автоматическое удаление остановлено.";
      return error;
    }
    private static string Hash(string path) { using(var stream=File.OpenRead(path))using(var hash=System.Security.Cryptography.SHA256.Create())return Convert.ToBase64String(hash.ComputeHash(stream)); }
    private Task<int> Run(string executable,IEnumerable<string> arguments,bool capture,int timeout=0) {
      return Task.Run(()=>{
        var start=new ProcessStartInfo(executable,Policy.Arguments(arguments)) {UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=capture,RedirectStandardError=capture};
        if(capture) {start.StandardOutputEncoding=Encoding.UTF8;start.StandardErrorEncoding=Encoding.UTF8;}
        using(var process=new Process {StartInfo=start}) {
          object gate=new object();
          Action<string> log=line=>{if(line==null)return;lock(gate)File.AppendAllText(technicalLog,line+Environment.NewLine,Encoding.UTF8);var progress=Policy.ReadProgress(line);if(progress!=null)window.Dispatcher.BeginInvoke(new Action(()=>{if(busy&&page==3)ApplyProgress(progress);}));};
          if(capture) {process.OutputDataReceived+=delegate(object sender,DataReceivedEventArgs e){log(e.Data);};process.ErrorDataReceived+=delegate(object sender,DataReceivedEventArgs e){log(e.Data);};}
          File.AppendAllText(technicalLog,DateTime.Now.ToString("o")+" "+Path.GetFileName(executable)+Environment.NewLine,Encoding.UTF8);
          process.Start();if(capture){process.BeginOutputReadLine();process.BeginErrorReadLine();}
          if(timeout>0&&!process.WaitForExit(timeout)){process.Kill();throw new Exception("Проверка установки заняла слишком долго. Повторите попытку.");}
          process.WaitForExit();return process.ExitCode;
        }
      });
    }
    public static int SelfTest(string output) {
      var tests=new List<string>();
      Action<bool,string> check=(value,name)=>{if(!value)throw new Exception(name);tests.Add(name);};
      check(Policy.CanUpdate(new Installation{Version="0.8.2"},"0.9.1"),"existing-older-updates");
      check(Policy.CanUpdate(new Installation{Version="0.9.1"},"0.9.1"),"same-version-repairs");
      check(Policy.VersionOf("0.9.1.0")==Policy.VersionOf("0.9.1"),"windows-version-normalized");
      check(!Policy.CanUpdate(new Installation{Version="1.0.0"},"0.9.1"),"newer-version-protected");
      check(!Policy.CanUpdate(new Installation{Version="0.8.2",Machine=true},"0.9.1"),"machine-installation-protected");
      check(Policy.Quote(@"C:\Aplot Folder\")=="\"C:\\Aplot Folder\\\\\"","windows-path-quoting");
      check(Policy.Arguments(new []{"/S",@"/D=C:\Aplot Folder"})=="/S /D=C:\\Aplot Folder","nsis-directory-tail");
      check(Policy.Arguments(new []{"/S","/DELETE_APP_DATA=1"})=="/S /DELETE_APP_DATA=1","nsis-switches-unquoted");
      check(Policy.Arguments(Policy.InstallArguments(@"C:\Aplot Folder",false,false))=="/S /SHORTCUTS=none /D=C:\\Aplot Folder","shortcuts-opt-in-only");
      check(Policy.InstallArguments(@"C:\Aplot",true,false)[1]=="/SHORTCUTS=desktop"&&Policy.InstallArguments(@"C:\Aplot",false,true)[1]=="/SHORTCUTS=startmenu"&&Policy.InstallArguments(@"C:\Aplot",true,true)[1]=="/SHORTCUTS=both","shortcuts-independent-choices");
      var progress=Policy.ReadProgress("APLOT_PROGRESS {\"stage\":\"download\",\"title\":\"download\",\"percent\":25,\"downloaded\":1024,\"total\":4096,\"rate\":512}");
      check(progress!=null&&progress.percent==25&&progress.downloaded==1024&&progress.total==4096,"structured-progress-parse");
      check(Policy.ReadProgress("APLOT_PROGRESS invalid")==null&&Policy.ReadProgress("ordinary log")==null,"progress-ignores-non-events");
      check(Policy.ReadProgress("APLOT_PROGRESS {\"title\":\"packages\"}").percent==null,"unknown-stage-has-no-fake-percent");
      check(!Policy.PythonAllowed(new []{"hermes","strata"},new HashSet<string>{"hermes"}),"python-dependency-guard");
      check(Policy.PythonAllowed(new []{"hermes","strata"},new HashSet<string>{"hermes","strata"}),"python-combined-removal");
      check(Policy.PreviousPage(2,false)==0,"express-back-skips-components");
      check(Policy.PreviousPage(2,true)==1,"custom-back-returns-components");
      check(Policy.DefaultDirectory()==Path.Combine(Path.GetPathRoot(Environment.SystemDirectory),"Aplot Control LLM"),"default-system-drive");
      bool rootRejected=false;try{Policy.AppDirectory(Path.GetPathRoot(Environment.SystemDirectory));}catch{rootRejected=true;}check(rootRejected,"drive-root-rejected");
      var catalog=ReadResourceJson("components.json");
      var components=ArrayOf(catalog,"components").Select(Obj).ToArray();
      var engineIds=new HashSet<string>(components.Where(row=>Str(row,"kind")=="engine").Select(row=>Str(row,"id")));
      check(components.Length==5,"packaged-component-catalog");
      check(engineIds.SetEquals(new [] {"llama_cpp","strata"}),"only-llama-and-strata-engines");
      check(!components.Any(row=>new [] {"ollama","qwfnfer","infernix"}.Contains(Str(row,"id"))),"legacy-engines-not-offered");
      var documents=ReadResourceJson("licenses.json");var licenseIds=new HashSet<string>(ArrayOf(documents,"licenses").Select(row=>Str(Obj(row),"id")));
      check(ArrayOf(catalog,"components").Select(Obj).All(row=>ArrayOf(row,"licenses").All(id=>licenseIds.Contains(Convert.ToString(id)))),"selected-component-licenses-packaged");
      check(ArrayOf(documents,"licenses").Select(Obj).All(row=>Str(row,"text").Length>200&&Str(row,"source").StartsWith("https://")),"license-texts-and-sources-present");
      using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("Installer.xaml")) {
        var layout=(Window)XamlReader.Load(stream);
        check(layout.ResizeMode==ResizeMode.NoResize,"fixed-window-size");
        check(layout.FindResource("FolderTreeItem") is Style,"folder-tree-style-resource");
        check(layout.FindName("ExpressInstall") is RadioButton && layout.FindName("CustomComponents") is RadioButton,"explicit-installation-modes");
        check(((CheckBox)layout.FindName("DesktopShortcut")).IsChecked==false&&((CheckBox)layout.FindName("StartMenuShortcut")).IsChecked==false,"shortcut-defaults-unchecked");
        check(!((ProgressBar)layout.FindName("OperationProgress")).IsIndeterminate&&!((ProgressBar)layout.FindName("OverallProgress")).IsIndeterminate,"no-indeterminate-progress-bars");
      }
      File.WriteAllText(output,Json.Serialize(new {passed=tests.Count,tests=tests}),Encoding.UTF8);return 0;
    }
  }
  internal static class Program {
    [STAThread] public static int Main(string[] argv) {
      var options=new Dictionary<string,string>();
      for(int i=0;i<argv.Length;i++)if(argv[i].StartsWith("--")){string key=argv[i].Substring(2);options[key]=i+1<argv.Length&&!argv[i+1].StartsWith("--")?argv[++i]:"true";}
      try {
        if(options.ContainsKey("self-test"))return Wizard.SelfTest(options["self-test"]);
        var app=new Application {ShutdownMode=ShutdownMode.OnExplicitShutdown};
        var wizard=new Wizard(options);app.Shutdown();return wizard.ExitCode;
      }catch(Exception e){File.WriteAllText(Path.Combine(Path.GetTempPath(),"aplot-wizard-error.txt"),e.ToString());if(!options.ContainsKey("self-test"))MessageBox.Show("Не удалось открыть мастер Aplot. "+e.Message,"Aplot",MessageBoxButton.OK,MessageBoxImage.Error);return 1;}
    }
  }
}
