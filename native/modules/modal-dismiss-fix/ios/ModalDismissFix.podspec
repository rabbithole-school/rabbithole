Pod::Spec.new do |s|
  s.name           = 'ModalDismissFix'
  s.version        = '1.0.0'
  s.summary        = 'Closes a React Native Modal together with whatever it is presenting'
  s.description    = 'A local Expo module with no JS API. At launch it applies the React Native main-branch fix for a Modal dismissed while presenting another view controller, which our precompiled React Native does not have yet.'
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

  s.frameworks = 'UIKit'

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
