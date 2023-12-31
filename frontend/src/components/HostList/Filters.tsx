import React, { useEffect, useMemo, useState } from "react"
import {
  InputGroup,
  InputLeftElement,
  Input,
  Stack,
  Button,
  useToast,
  useDisclosure,
  AlertDialog,
  AlertDialogOverlay,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogBody,
  AlertDialogFooter,
  HStack,
  Box,
} from "@chakra-ui/react"
import { BsSearch } from "icons/bs/BsSearch"
import debounce from "lodash/debounce"
import { GetHostParams } from "@common/api/endpoint"
import { deleteHosts } from "api/endpoints"
import { makeToast } from "utils"
import { formatMetloAPIErr, MetloAPIErr } from "api/utils"
import { Select } from "chakra-react-select"
import { HostType } from "@common/enums"

interface HostFilterProps {
  params: GetHostParams
  setParams: (t: (e: GetHostParams) => GetHostParams) => void
  selectedHosts: string[]
  setSelectedHosts: React.Dispatch<React.SetStateAction<string[]>>
}

const HostFilters: React.FC<HostFilterProps> = React.memo(
  ({ params, setParams, selectedHosts, setSelectedHosts }) => {
    const setSearchQuery = (searchQuery: string) => {
      setParams(old => ({
        ...old,
        searchQuery,
        offset: 0,
      }))
    }
    const [tmpQuery, setTmpQuery] = useState<string>(params.searchQuery)
    const debounceSearch = useMemo(
      () => debounce(setSearchQuery, 500),
      [params],
    )
    const [deleting, setDeleting] = useState<boolean>(false)
    const toast = useToast()
    const { isOpen, onOpen, onClose } = useDisclosure()
    const cancelRef = React.useRef()

    useEffect(() => {
      setTmpQuery(params.searchQuery)

      return () => {
        debounceSearch.cancel()
      }
    }, [params.searchQuery, params.hostType])

    const handleDeleteHostsClick = async () => {
      try {
        setDeleting(true)
        onClose()
        await deleteHosts(selectedHosts)
        toast(
          makeToast({
            title: `Deleted hosts ${selectedHosts.join(", ")}`,
            status: "success",
          }),
        )
        setSelectedHosts([])
        setParams(old => ({
          ...old,
          offset: 0,
        }))
      } catch (err) {
        toast(
          makeToast({
            title: "Deleting hosts failed...",
            status: "error",
            description: formatMetloAPIErr(err.response.data as MetloAPIErr),
          }),
        )
      } finally {
        setDeleting(false)
      }
    }

    return (
      <Stack
        direction={{ base: "column", sm: "row" }}
        w="full"
        justifyContent="space-between"
      >
        <HStack spacing={4}>
          <Box>
            <InputGroup>
              <InputLeftElement pointerEvents="none">
                <BsSearch />
              </InputLeftElement>
              <Input
                spellCheck={false}
                value={tmpQuery}
                onChange={e => {
                  debounceSearch(e.target.value)
                  setTmpQuery(e.target.value)
                }}
                w={{ base: "full", lg: "xs" }}
                type="text"
                placeholder="Search for host..."
                bg="white"
              />
            </InputGroup>
          </Box>
          <Box w={{ base: "full", lg: "xs" }}>
            <Select
              className="chakra-react-select"
              options={[
                { label: HostType.ANY, value: HostType.ANY },
                { label: HostType.PUBLIC, value: HostType.PUBLIC },
                { label: HostType.PRIVATE, value: HostType.PRIVATE },
              ]}
              value={{
                label: params.hostType || HostType.ANY,
                value: params.hostType || HostType.ANY,
              }}
              onChange={e => {
                setParams(old => ({
                  ...old,
                  hostType: e.label || HostType.ANY,
                }))
              }}
              placeholder="Host public visibility..."
            />
          </Box>
        </HStack>
        <Button
          variant="delete"
          isDisabled={selectedHosts.length === 0}
          isLoading={deleting}
          onClick={onOpen}
        >
          Delete
        </Button>
        <AlertDialog
          isOpen={isOpen}
          leastDestructiveRef={cancelRef}
          onClose={onClose}
        >
          <AlertDialogOverlay>
            <AlertDialogContent>
              <AlertDialogHeader fontSize="lg" fontWeight="bold">
                Delete Host
              </AlertDialogHeader>

              <AlertDialogBody>
                Are you sure you want to delete hosts{" "}
                <strong>{selectedHosts.join(", ")}</strong> ?
              </AlertDialogBody>

              <AlertDialogFooter>
                <Button ref={cancelRef} onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  isLoading={deleting}
                  variant="delete"
                  onClick={handleDeleteHostsClick}
                  ml={3}
                >
                  Delete
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialogOverlay>
        </AlertDialog>
      </Stack>
    )
  },
)

export default HostFilters
