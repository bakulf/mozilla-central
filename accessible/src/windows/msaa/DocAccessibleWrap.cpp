/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/dom/TabChild.h"

#include "Compatibility.h"
#include "DocAccessibleWrap.h"
#include "ISimpleDOMDocument_i.c"
#include "nsCoreUtils.h"
#include "nsIAccessibilityService.h"
#include "nsWinUtils.h"
#include "Role.h"
#include "RootAccessible.h"
#include "Statistics.h"

#include "nsIDocShell.h"
#include "nsIDocShellTreeNode.h"
#include "nsIInterfaceRequestorUtils.h"
#include "nsISelectionController.h"
#include "nsIServiceManager.h"
#include "nsIURI.h"
#include "nsViewManager.h"
#include "nsIWebNavigation.h"

using namespace mozilla;
using namespace mozilla::a11y;

/* For documentation of the accessibility architecture, 
 * see http://lxr.mozilla.org/seamonkey/source/accessible/accessible-docs.html
 */

////////////////////////////////////////////////////////////////////////////////
// DocAccessibleWrap
////////////////////////////////////////////////////////////////////////////////

DocAccessibleWrap::
  DocAccessibleWrap(nsIDocument* aDocument, nsIContent* aRootContent,
                    nsIPresShell* aPresShell) :
  DocAccessible(aDocument, aRootContent, aPresShell), mHWND(nullptr)
{
}

DocAccessibleWrap::~DocAccessibleWrap()
{
}

//-----------------------------------------------------
// IUnknown interface methods - see iunknown.h for documentation
//-----------------------------------------------------
STDMETHODIMP_(ULONG)
DocAccessibleWrap::AddRef()
{
  return nsAccessNode::AddRef();
}

STDMETHODIMP_(ULONG) DocAccessibleWrap::Release()
{
  return nsAccessNode::Release();
}

// Microsoft COM QueryInterface
STDMETHODIMP
DocAccessibleWrap::QueryInterface(REFIID iid, void** ppv)
{
  if (!ppv)
    return E_INVALIDARG;

  *ppv = nullptr;

  if (IID_ISimpleDOMDocument != iid)
    return HyperTextAccessibleWrap::QueryInterface(iid, ppv);

  statistics::ISimpleDOMUsed();
  *ppv = static_cast<ISimpleDOMDocument*>(this);
  (reinterpret_cast<IUnknown*>(*ppv))->AddRef();
  return S_OK;
}

STDMETHODIMP
DocAccessibleWrap::get_URL(/* [out] */ BSTR __RPC_FAR *aURL)
{
  A11Y_TRYBLOCK_BEGIN

  if (!aURL)
    return E_INVALIDARG;

  *aURL = nullptr;

  nsAutoString URL;
  nsresult rv = GetURL(URL);
  if (NS_FAILED(rv))
    return E_FAIL;

  if (URL.IsEmpty())
    return S_FALSE;

  *aURL = ::SysAllocStringLen(URL.get(), URL.Length());
  return *aURL ? S_OK : E_OUTOFMEMORY;

  A11Y_TRYBLOCK_END
}

STDMETHODIMP
DocAccessibleWrap::get_title( /* [out] */ BSTR __RPC_FAR *aTitle)
{
  A11Y_TRYBLOCK_BEGIN

  if (!aTitle)
    return E_INVALIDARG;

  *aTitle = nullptr;

  nsAutoString title;
  nsresult rv = GetTitle(title);
  if (NS_FAILED(rv))
    return E_FAIL;

  *aTitle = ::SysAllocStringLen(title.get(), title.Length());
  return *aTitle ? S_OK : E_OUTOFMEMORY;

  A11Y_TRYBLOCK_END
}

STDMETHODIMP
DocAccessibleWrap::get_mimeType(/* [out] */ BSTR __RPC_FAR *aMimeType)
{
  A11Y_TRYBLOCK_BEGIN

  if (!aMimeType)
    return E_INVALIDARG;

  *aMimeType = nullptr;

  nsAutoString mimeType;
  nsresult rv = GetMimeType(mimeType);
  if (NS_FAILED(rv))
    return E_FAIL;

  if (mimeType.IsEmpty())
    return S_FALSE;

  *aMimeType = ::SysAllocStringLen(mimeType.get(), mimeType.Length());
  return *aMimeType ? S_OK : E_OUTOFMEMORY;

  A11Y_TRYBLOCK_END
}

STDMETHODIMP
DocAccessibleWrap::get_docType(/* [out] */ BSTR __RPC_FAR *aDocType)
{
  A11Y_TRYBLOCK_BEGIN

  if (!aDocType)
    return E_INVALIDARG;

  *aDocType = nullptr;

  nsAutoString docType;
  nsresult rv = GetDocType(docType);
  if (NS_FAILED(rv))
    return E_FAIL;

  if (docType.IsEmpty())
    return S_FALSE;

  *aDocType = ::SysAllocStringLen(docType.get(), docType.Length());
  return *aDocType ? S_OK : E_OUTOFMEMORY;

  A11Y_TRYBLOCK_END
}

STDMETHODIMP
DocAccessibleWrap::get_nameSpaceURIForID(/* [in] */  short aNameSpaceID,
  /* [out] */ BSTR __RPC_FAR *aNameSpaceURI)
{
  A11Y_TRYBLOCK_BEGIN

  if (!aNameSpaceURI)
    return E_INVALIDARG;

  *aNameSpaceURI = nullptr;

  if (aNameSpaceID < 0)
    return E_INVALIDARG;  // -1 is kNameSpaceID_Unknown

  nsAutoString nameSpaceURI;
  nsresult rv = GetNameSpaceURIForID(aNameSpaceID, nameSpaceURI);
  if (NS_FAILED(rv))
    return E_FAIL;

  if (nameSpaceURI.IsEmpty())
    return S_FALSE;

  *aNameSpaceURI = ::SysAllocStringLen(nameSpaceURI.get(),
                                       nameSpaceURI.Length());

  return *aNameSpaceURI ? S_OK : E_OUTOFMEMORY;

  A11Y_TRYBLOCK_END
}

STDMETHODIMP
DocAccessibleWrap::put_alternateViewMediaTypes( /* [in] */ BSTR __RPC_FAR *aCommaSeparatedMediaTypes)
{
  A11Y_TRYBLOCK_BEGIN

  if (!aCommaSeparatedMediaTypes)
    return E_INVALIDARG;

  *aCommaSeparatedMediaTypes = nullptr;
  return E_NOTIMPL;

  A11Y_TRYBLOCK_END
}

STDMETHODIMP
DocAccessibleWrap::get_accValue(
      /* [optional][in] */ VARIANT varChild,
      /* [retval][out] */ BSTR __RPC_FAR *pszValue)
{
  if (!pszValue)
    return E_INVALIDARG;

  // For backwards-compat, we still support old MSAA hack to provide URL in accValue
  *pszValue = nullptr;
  // Check for real value first
  HRESULT hr = AccessibleWrap::get_accValue(varChild, pszValue);
  if (FAILED(hr) || *pszValue || varChild.lVal != CHILDID_SELF)
    return hr;
  // If document is being used to create a widget, don't use the URL hack
  roles::Role role = Role();
  if (role != roles::DOCUMENT && role != roles::APPLICATION && 
      role != roles::DIALOG && role != roles::ALERT) 
    return hr;

  return get_URL(pszValue);
}

////////////////////////////////////////////////////////////////////////////////
// nsAccessNode

void
DocAccessibleWrap::Shutdown()
{
  // Do window emulation specific shutdown if emulation was started.
  if (nsWinUtils::IsWindowEmulationStarted()) {
    // Destroy window created for root document.
    if (mDocFlags & eTabDocument) {
      nsWinUtils::sHWNDCache->Remove(mHWND);
      ::DestroyWindow(static_cast<HWND>(mHWND));
    }

    mHWND = nullptr;
  }

  DocAccessible::Shutdown();
}

////////////////////////////////////////////////////////////////////////////////
// DocAccessible public

void*
DocAccessibleWrap::GetNativeWindow() const
{
  return mHWND ? mHWND : DocAccessible::GetNativeWindow();
}

////////////////////////////////////////////////////////////////////////////////
// DocAccessible protected

void
DocAccessibleWrap::DoInitialUpdate()
{
  DocAccessible::DoInitialUpdate();

  if (nsWinUtils::IsWindowEmulationStarted()) {
    // Create window for tab document.
    if (mDocFlags & eTabDocument) {
      mozilla::dom::TabChild* tabChild =
        mozilla::dom::GetTabChildFrom(mDocumentNode->GetShell());

      a11y::RootAccessible* rootDocument = RootAccessible();

      mozilla::WindowsHandle nativeData = 0;
      if (tabChild)
        tabChild->SendGetWidgetNativeData(&nativeData);
      else
        nativeData = reinterpret_cast<mozilla::WindowsHandle>(
          rootDocument->GetNativeWindow());

      bool isActive = true;
      int32_t x = CW_USEDEFAULT, y = CW_USEDEFAULT, width = 0, height = 0;
      if (Compatibility::IsDolphin()) {
        GetBounds(&x, &y, &width, &height);
        int32_t rootX = 0, rootY = 0, rootWidth = 0, rootHeight = 0;
        rootDocument->GetBounds(&rootX, &rootY, &rootWidth, &rootHeight);
        x = rootX - x;
        y -= rootY;

        nsCOMPtr<nsISupports> container = mDocumentNode->GetContainer();
        nsCOMPtr<nsIDocShell> docShell = do_QueryInterface(container);
        docShell->GetIsActive(&isActive);
      }

      HWND parentWnd = reinterpret_cast<HWND>(nativeData);
      mHWND = nsWinUtils::CreateNativeWindow(kClassNameTabContent, parentWnd,
                                             x, y, width, height, isActive);

      nsWinUtils::sHWNDCache->Put(mHWND, this);

    } else {
      DocAccessible* parentDocument = ParentDocument();
      if (parentDocument)
        mHWND = parentDocument->GetNativeWindow();
    }
  }
}
