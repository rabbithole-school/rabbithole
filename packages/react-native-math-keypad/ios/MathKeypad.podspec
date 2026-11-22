require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'MathKeypad'
  s.version        = package['version']
  s.summary        = 'Hardware-keyboard support for react-native-math-keypad'
  s.description    = 'Two optional Expo modules: GCKeyboard-based hardware keyboard detection, and an off-screen first responder that forwards Tab, Shift-Tab, arrows and editor keys (which a React Native TextInput never receives on iOS) to the 2-D math editor.'
  s.license        = package['license']
  s.author         = package['author']
  s.homepage       = package['homepage']
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'GameController'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift}"
end
