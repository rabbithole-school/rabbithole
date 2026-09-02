Pod::Spec.new do |s|
  s.name           = 'KeyCapture'
  s.version        = '1.0.0'
  s.summary        = 'Hardware-keyboard key capture for the 2-D expression editor'
  s.description    = 'A local Expo module hosting an off-screen first-responder UIView that forwards hardware-keyboard keys — including Tab / Shift-Tab / the arrow keys, which a React Native TextInput onKeyPress never receives — to JS via pressesBegan, so the native math expression editor gets the same keyboard navigation the web editor has.'
  s.author         = 'Rabbithole'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
