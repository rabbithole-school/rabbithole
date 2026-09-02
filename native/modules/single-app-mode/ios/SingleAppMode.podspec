Pod::Spec.new do |s|
  s.name           = 'SingleAppMode'
  s.version        = '1.0.0'
  s.summary        = 'Autonomous Single App Mode (ASAM) control for Rabbithole'
  s.description    = 'A local Expo module that lets the app lock/unlock ITSELF into iOS Single App Mode via UIAccessibility.requestGuidedAccessSession (Autonomous Single App Mode), provided the bundle is whitelisted for ASAM by MDM. NO-OP-fails gracefully when not permitted.'
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
